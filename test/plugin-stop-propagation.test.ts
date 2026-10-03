import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contribute from "../plugin/index.server";
import {
  REVIEWER_STOP_NOTICE,
  STOP_RECHECK_MS,
  propagateWorkerStop,
  stopAllInWorkspace,
  type StopPaseo,
} from "../plugin/server/stop-propagation";
import { WORKER_STOP_NOTICE } from "../plugin/server/notices";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * bm-wq6 (REQ-026f): when the user stops a Beads Worker, Paseo only cancels the
 * Worker's turn. The plugin hears `agent.turn_ended` with a canceled outcome and
 * interrupts each running Reviewer of that Worker with a fixed stop notice.
 */

const WORKER = "worker-1";
const WS = "ws-1";

type Snapshot = {
  id: string;
  workspaceId?: string;
  status: string;
  labels: Record<string, string>;
  provider?: string;
  archivedAt?: string | null;
};
type Event = {
  agent: { id: string; workspaceId: string | null; parentAgentId: string | null; provider: string; cwd: string; title: string | null };
  turnId: string | null;
  outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string };
  timeline: readonly unknown[];
};
type OnHandler = (event: Event, context: { paseo: unknown; signal: AbortSignal }) => Promise<void> | void;

function reviewer(id: string, overrides: Partial<Snapshot> = {}, labels: Record<string, string> = {}): Snapshot {
  return {
    id,
    workspaceId: WS,
    status: "running",
    provider: "bm-reviewer",
    labels: { "bm.role": "reviewer", "paseo.parent-agent-id": WORKER, ...labels },
    ...overrides,
  };
}

function event(provider = "bm-worker", outcome: Event["outcome"] = { kind: "canceled", reason: "interrupted" }): Event {
  return {
    agent: { id: WORKER, workspaceId: WS, parentAgentId: "manager-1", provider, cwd: "/repo", title: "Beads Worker" },
    turnId: "turn-1",
    outcome,
    timeline: [],
  };
}

/**
 * The shared fake SDK. Its listing ignores the filter (so client-side filtering
 * is exercised) and pages two entries at a time. It holds the stopped Worker (no
 * labels, idle unless `statuses` says otherwise) and the given agents;
 * `statuses` is what successive re-reads of an agent report, sticking on the
 * last; `listError` rejects every listing and `sendError` a send to that agent.
 */
function daemonWith(options: { agents: Snapshot[]; statuses?: Record<string, string[]>; listError?: Error; sendError?: Record<string, Error> }) {
  const fake = fakePaseo<StopPaseo>({
    agents: [{ id: WORKER, workspaceId: WS, status: "idle", labels: {} }, ...options.agents],
    statuses: options.statuses ?? {},
    pageSize: 2,
    ignoresListFilter: true,
  });
  if (options.listError) fake.api.agents.list.mockRejectedValue(options.listError);
  for (const [id, error] of Object.entries(options.sendError ?? {})) fake.handle(id).send.mockRejectedValue(error);
  return { paseo: fake.paseo, sends: fake.sends, listCalls: fake.lists, refreshes: fake.refreshes, handle: fake.handle };
}

function fakeServer(options: { withOn?: boolean } = {}) {
  // Since WP-205 the server entry registers three lifecycle hooks: this one on
  // agent.turn_ended, plus the trace collector on turn_started and turn_ended.
  // The fake therefore keeps every handler per name, and `setup()` picks the
  // stop-propagation one (the first turn_ended handler the entry registers).
  const hooks = new Map<string, OnHandler[]>();
  const removers: string[] = [];
  const server: Record<string, unknown> = {
    handle: vi.fn(),
    registerSettings: vi.fn(),
    before: vi.fn(() => () => {}),
  };
  if (options.withOn !== false) {
    server.on = vi.fn((name: string, handler: OnHandler) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      return () => {
        removers.push(name);
        const left = (hooks.get(name) ?? []).filter((entry) => entry !== handler);
        if (left.length === 0) hooks.delete(name);
        else hooks.set(name, left);
      };
    });
  }
  return { server, hooks, removers };
}

function setup() {
  const fake = fakeServer();
  const cleanup = contribute(fake.server as unknown as Parameters<typeof contribute>[0]);
  const hook = fake.hooks.get("agent.turn_ended")?.[0];
  expect(hook).toBeTypeOf("function");
  const run = async (ev: Event, paseo: unknown, signal = new AbortController().signal) => {
    const pending = Promise.resolve(hook!(ev, { paseo, signal }));
    await vi.advanceTimersByTimeAsync(STOP_RECHECK_MS * 4);
    await expect(pending).resolves.toBeUndefined();
  };
  return { ...fake, cleanup, run };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("on(\"agent.turn_ended\") stop propagation", () => {
  it("exports the exact stop notice", () => {
    expect(REVIEWER_STOP_NOTICE).toBe(
      'STOP: The Beads Worker that created you was stopped by the user. Stop this review now: do not read files, run commands or call any tool; reply with the single line "BM-REVIEW STOPPED" and end your turn.',
    );
    expect(STOP_RECHECK_MS).toBe(500);
  });

  it("registers its agent.turn_ended hook alongside the trace collector's two", () => {
    const { server, hooks } = setup();
    // One here (bm-wq6) plus the WP-205 collector's turn_started and turn_ended,
    // plus delta 20260918g's agent.created labelling, its turn_started scan and
    // its turn_ended BM-FORMAT check, plus delta 20260921's fallback detection,
    // plus the outdated-agents pass (turn_started, agent.archived; autonomy
    // design §A.11), plus the action boundary's two permission hooks (§D.2),
    // plus the interruption watch's permission_resolved (ADR-024),
    // plus the binding lifecycle's agent.archived (design §16.5),
    // plus the off-tool Reviewer alert's clear on agent.archived (design §16.8).
    // The no-verdict check (§16.10) rides on the fallback detection's
    // turn_ended handler (its afterDetection), so it adds no hook.
    // The question–answer ledger's turn_ended is retired (§A.14).
    expect(server.on).toHaveBeenCalledTimes(14);
    expect([...hooks.keys()].sort()).toEqual([
      "agent.archived",
      "agent.created",
      "agent.permission_requested",
      "agent.permission_resolved",
      "agent.turn_ended",
      "agent.turn_started",
    ]);
    expect(hooks.get("agent.turn_ended")).toHaveLength(4);
    // The outdated-agents clear, the binding revoke (§16.5) and the off-tool alert clear (§16.8).
    expect(hooks.get("agent.archived")).toHaveLength(3);
  });

  it("sends the notice only to the stopped Worker's running Reviewers (idle Worker on refresh)", async () => {
    const { run } = setup();
    const { paseo, sends, listCalls } = daemonWith({
      agents: [
        reviewer("rev-a"),
        reviewer("rev-other-worker", {}, { "paseo.parent-agent-id": "worker-2" }),
        reviewer("rev-idle", { status: "idle" }),
        reviewer("rev-archived", { archivedAt: "2026-09-15T12:00:00.000Z" }),
        reviewer("child-not-reviewer", { provider: "bm-worker" }, { "bm.role": "worker" }),
        reviewer("child-unlabeled", { provider: "claude" }, { "bm.role": "" }),
        // A bm.role label alone never makes a Reviewer (design §16.3).
        reviewer("child-label-only", { provider: "claude" }),
        reviewer("rev-other-ws", { workspaceId: "ws-2" }),
        reviewer("rev-b"),
      ],
      statuses: { [WORKER]: ["idle"] },
    });
    await run(event(), paseo);
    expect(sends).toEqual([
      { id: "rev-a", text: REVIEWER_STOP_NOTICE },
      { id: "rev-b", text: REVIEWER_STOP_NOTICE },
    ]);
    // Nine Reviewers and the stopped Worker itself: five pages of two.
    expect(listCalls.length).toBe(5);
    // Parent label only since delta 20260918g §4.2: the reviewer role is decided
    // per agent (by the bm-reviewer provider), not by the daemon's filter.
    expect(listCalls[0]).toEqual({
      filter: { labels: { "paseo.parent-agent-id": WORKER }, includeArchived: false },
      page: { limit: 200 },
    });
    expect(listCalls[1]).toEqual(expect.objectContaining({ page: { limit: 200, cursor: "2" } }));
  });

  it("stops a running Reviewer of the Worker that carries no bm.role label, by its bm-reviewer provider (delta 20260918g)", async () => {
    const { paseo, sends } = daemonWith({
      agents: [
        reviewer("rev-plain", { labels: { "paseo.parent-agent-id": WORKER }, provider: "bm-reviewer/gpt-5.6-sol" }),
        { id: "m-plain", workspaceId: WS, status: "running", labels: { "paseo.parent-agent-id": WORKER }, provider: "bm-manager" },
      ],
      statuses: { [WORKER]: ["idle"] },
    });
    await propagateWorkerStop(event() as never, { paseo: paseo as never });
    expect(sends).toEqual([{ id: "rev-plain", text: REVIEWER_STOP_NOTICE }]);
  });

  it("does nothing when an Orchestrator's turn is canceled, and never stops an Orchestrator child of the Worker (orchestrator design §3.2)", async () => {
    const orchestratorChild = reviewer("orc-child", { provider: "bm-orchestrator" }, { "bm.role": "orchestrator" });
    const { paseo, sends, listCalls } = daemonWith({ agents: [orchestratorChild, reviewer("rev-a")], statuses: { [WORKER]: ["idle"] } });
    for (const provider of ["bm-orchestrator", "bm-orchestrator/claude-opus-5"]) {
      await propagateWorkerStop(event(provider) as never, { paseo: paseo as never });
    }
    expect(listCalls).toEqual([]);
    expect(sends).toEqual([]);
    await propagateWorkerStop(event() as never, { paseo: paseo as never });
    expect(sends).toEqual([{ id: "rev-a", text: REVIEWER_STOP_NOTICE }]);
  });

  it("recognises a bm-worker/<model> provider", async () => {
    const { run } = setup();
    const { paseo, sends } = daemonWith({ agents: [reviewer("rev-a")], statuses: { [WORKER]: ["idle"] } });
    await run(event("bm-worker/gpt-5.6-sol"), paseo);
    expect(sends).toEqual([{ id: "rev-a", text: REVIEWER_STOP_NOTICE }]);
  });

  it("recognises a fallback Worker bm-worker-fallback-1/<model> (delta 20260921 §4.4.1)", async () => {
    const { run } = setup();
    const { paseo, sends } = daemonWith({ agents: [reviewer("rev-a")], statuses: { [WORKER]: ["idle"] } });
    await run(event("bm-worker-fallback-1/qwen3-coder"), paseo);
    expect(sends).toEqual([{ id: "rev-a", text: REVIEWER_STOP_NOTICE }]);
  });

  it("does nothing when the Worker is still running after the re-check (a message replaced the turn)", async () => {
    const { run } = setup();
    const { paseo, sends, refreshes } = daemonWith({
      agents: [reviewer("rev-a")],
      statuses: { [WORKER]: ["running", "running"] },
    });
    await run(event(), paseo);
    expect(refreshes.filter((id) => id === WORKER)).toHaveLength(2);
    expect(paseo.agents.list).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
  });

  it("waits STOP_RECHECK_MS once, then sends when the Worker has gone idle", async () => {
    const { hooks } = setup();
    const { paseo, sends, refreshes } = daemonWith({
      agents: [reviewer("rev-a")],
      statuses: { [WORKER]: ["running", "idle"] },
    });
    const pending = Promise.resolve(hooks.get("agent.turn_ended")![0]!(event(), { paseo, signal: new AbortController().signal }));
    await vi.advanceTimersByTimeAsync(STOP_RECHECK_MS - 1);
    expect(refreshes.filter((id) => id === WORKER)).toHaveLength(1);
    expect(sends).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(refreshes.filter((id) => id === WORKER)).toHaveLength(2);
    expect(sends).toEqual([{ id: "rev-a", text: REVIEWER_STOP_NOTICE }]);
  });

  it.each([
    ["completed outcome", event("bm-worker", { kind: "completed" })],
    ["failed outcome", event("bm-worker", { kind: "failed", error: { message: "boom" } })],
    ["bm-reviewer", event("bm-reviewer")],
    ["bm-manager", event("bm-manager/opus")],
    ["claude", event("claude")],
    ["bm-workers", event("bm-workers")],
  ])("ignores %s", async (_name, ev) => {
    const { run } = setup();
    const { paseo, sends } = daemonWith({ agents: [reviewer("rev-a")], statuses: { [WORKER]: ["idle"] } });
    await run(ev, paseo);
    expect(paseo.agents.ref).not.toHaveBeenCalled();
    expect(paseo.agents.list).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
  });

  it("skips a Reviewer that became idle before the send", async () => {
    const { run } = setup();
    const { paseo, sends } = daemonWith({
      agents: [reviewer("rev-a"), reviewer("rev-b")],
      statuses: { [WORKER]: ["idle"], "rev-a": ["idle"] },
    });
    await run(event(), paseo);
    expect(sends).toEqual([{ id: "rev-b", text: REVIEWER_STOP_NOTICE }]);
  });

  it("resolves and logs when list rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { run } = setup();
    const { paseo, sends } = daemonWith({ agents: [reviewer("rev-a")], statuses: { [WORKER]: ["idle"] }, listError: new Error("daemon gone") });
    await run(event(), paseo);
    expect(sends).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[paseo-bm\] stop propagation: .*daemon gone/);
  });

  it("resolves, logs and carries on with the next Reviewer when send rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { run } = setup();
    const { paseo, sends } = daemonWith({
      agents: [reviewer("rev-a"), reviewer("rev-b")],
      statuses: { [WORKER]: ["idle"] },
      sendError: { "rev-a": new Error("send refused") },
    });
    await run(event(), paseo);
    expect(sends).toEqual([{ id: "rev-b", text: REVIEWER_STOP_NOTICE }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[paseo-bm\] stop propagation: .*rev-a.*send refused/);
  });

  it("resolves and logs when the Worker cannot be re-read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { paseo, sends, handle } = daemonWith({ agents: [reviewer("rev-a")] });
    handle(WORKER).refresh.mockRejectedValue(new Error("no snapshot"));
    const { run } = setup();
    await run(event(), paseo);
    expect(sends).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[paseo-bm\] stop propagation: .*no snapshot/);
  });

  it("sends nothing when the signal is already aborted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { run } = setup();
    const { paseo, sends } = daemonWith({ agents: [reviewer("rev-a")], statuses: { [WORKER]: ["idle"] } });
    const controller = new AbortController();
    controller.abort();
    await run(event(), paseo, controller.signal);
    expect(sends).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends nothing when the signal aborts during the re-check wait", async () => {
    const { paseo, sends } = daemonWith({
      agents: [reviewer("rev-a")],
      statuses: { [WORKER]: ["running", "idle"] },
    });
    const controller = new AbortController();
    const pending = propagateWorkerStop(event() as never, { paseo, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(STOP_RECHECK_MS / 2);
    controller.abort();
    await vi.advanceTimersByTimeAsync(STOP_RECHECK_MS);
    await expect(pending).resolves.toBeUndefined();
    expect(sends).toEqual([]);
    expect(paseo.agents.list).not.toHaveBeenCalled();
  });

  it.each([
    ["undefined event", undefined],
    ["empty event", {}],
    ["event without agent", { outcome: { kind: "canceled", reason: "x" } }],
  ])("never throws on a malformed event (%s)", async (_name, ev) => {
    const { run } = setup();
    const { paseo, sends } = daemonWith({ agents: [reviewer("rev-a")] });
    await run(ev as unknown as Event, paseo);
    expect(sends).toEqual([]);
  });

  it("removes the hook on cleanup", () => {
    const { cleanup, hooks, removers } = setup();
    cleanup();
    // Fourteen removals, one per registration: this hook, the WP-205
    // collector's turn_started and turn_ended, delta 20260918g's agent.created,
    // turn_started scan and turn_ended BM-FORMAT check, delta 20260921's
    // fallback detection (turn_ended, which also runs the §16.10 no-verdict
    // check), the outdated-agents pass (turn_started, agent.archived), the
    // action boundary (permission_requested, permission_resolved; §D.2), the
    // interruption watch (permission_resolved; ADR-024), the binding
    // lifecycle (agent.archived; §16.5) and the off-tool Reviewer alert's
    // clear (agent.archived; §16.8). The map must end up empty.
    expect([...removers].sort()).toEqual([
      "agent.archived",
      "agent.archived",
      "agent.archived",
      "agent.created",
      "agent.permission_requested",
      "agent.permission_resolved",
      "agent.permission_resolved",
      "agent.turn_ended",
      "agent.turn_ended",
      "agent.turn_ended",
      "agent.turn_ended",
      "agent.turn_started",
      "agent.turn_started",
      "agent.turn_started",
    ]);
    expect(hooks.size).toBe(0);
  });

  it("skips the hook safely, with one log line, on a host without on()", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { server } = fakeServer({ withOn: false });
    let cleanup: () => void = () => {};
    expect(() => {
      cleanup = contribute(server as unknown as Parameters<typeof contribute>[0]);
    }).not.toThrow();
    // Two lines now: this hook's, and the trace collector's (also on()).
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((call) => String(call[0])).join(" ")).toMatch(/agent\.turn_ended/);
    expect(warn.mock.calls.map((call) => String(call[0])).join(" ")).toMatch(/no trace history/);
    expect(() => cleanup()).not.toThrow();
  });

  it("logs only the role hook's line on a host with no lifecycle hooks at all", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = { handle: vi.fn(), registerSettings: vi.fn() };
    let cleanup: () => void = () => {};
    expect(() => {
      cleanup = contribute(server as unknown as Parameters<typeof contribute>[0]);
    }).not.toThrow();
    // Both on()-based features stay quiet here so one missing host capability
    // does not become three log lines; the role hook's line is the useful one.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/agent\.create/);
    expect(() => cleanup()).not.toThrow();
  });
});


/**
 * `/bm-worker-stop-all` (delta 20260917e §4.4).
 *
 * Paseo gives plugins no agent cancel, so this ASKS: a `send()` on a running
 * agent replaces the turn it is in with one carrying a stop notice. Every case
 * below guards one of the three promises the command makes — the Manager is
 * never touched, only this workspace is touched, and an archived agent is never
 * resurrected.
 */
describe("stopAllInWorkspace", () => {
  const worker = (id: string, overrides: Partial<Snapshot> = {}): Snapshot => ({
    id,
    workspaceId: WS,
    status: "running",
    provider: "bm-worker",
    labels: { "bm.role": "worker" },
    ...overrides,
  });
  const managerAgent = (id: string): Snapshot => ({
    id,
    workspaceId: WS,
    status: "running",
    provider: "bm-manager",
    labels: { "bm.role": "manager" },
  });

  it("asks every running Worker and Reviewer of the workspace", async () => {
    const { paseo, sends } = daemonWith({ agents: [worker("w1"), reviewer("rev-a")] });
    const result = await stopAllInWorkspace(paseo as never, WS);
    expect(result).toEqual({ workers: 1, reviewers: 1, skipped: 0 });
    expect(sends.map((s) => s.id).sort()).toEqual(["rev-a", "w1"]);
    expect(sends.find((s) => s.id === "w1")?.text).toBe(WORKER_STOP_NOTICE);
    expect(sends.find((s) => s.id === "rev-a")?.text).toBe(REVIEWER_STOP_NOTICE);
  });

  it("never asks the Manager, whatever the daemon's filter returns", async () => {
    // The fake ignores the label filter on purpose, so this exercises the
    // client-side check. The Manager is the user's point of contact.
    const { paseo, sends } = daemonWith({ agents: [managerAgent("m1"), worker("w1")] });
    const result = await stopAllInWorkspace(paseo as never, WS);
    expect(sends.map((s) => s.id)).toEqual(["w1"]);
    expect(result.workers).toBe(1);
  });

  it("leaves another workspace alone", async () => {
    const { paseo, sends } = daemonWith({
      agents: [worker("w1"), worker("w-elsewhere", { workspaceId: "wks_other" })],
    });
    await stopAllInWorkspace(paseo as never, WS);
    expect(sends.map((s) => s.id)).toEqual(["w1"]);
  });

  it("drops an archived agent at the listing, without even re-reading it", async () => {
    // `send()` un-archives (ADR-005): agents belong to the user. Two layers
    // catch this — the listing filter and the re-read before the send — so the
    // assertion is on `refreshes`: without the listing filter the archived
    // agent would still be re-read, and only the second layer would save it.
    const { paseo, sends, refreshes } = daemonWith({
      agents: [worker("w-archived", { archivedAt: "2026-09-17T00:00:00.000Z" }), worker("w1")],
    });
    const result = await stopAllInWorkspace(paseo as never, WS);
    expect(sends.map((s) => s.id)).toEqual(["w1"]);
    expect(result.workers).toBe(1);
    expect(refreshes).not.toContain("w-archived");
  });

  it("skips an agent that stopped running between the listing and the send", async () => {
    const { paseo, sends } = daemonWith({ agents: [worker("w1")], statuses: { w1: ["idle"] } });
    const result = await stopAllInWorkspace(paseo as never, WS);
    expect(sends).toEqual([]);
    expect(result).toEqual({ workers: 0, reviewers: 0, skipped: 1 });
  });

  it("counts a failed send as skipped and keeps going", async () => {
    const { paseo, sends } = daemonWith({
      agents: [worker("w1"), worker("w2")],
      sendError: { w1: new Error("agent gone") },
    });
    const logged: string[] = [];
    const result = await stopAllInWorkspace(paseo as never, WS, (message) => logged.push(message));
    expect(sends.map((s) => s.id)).toEqual(["w2"]);
    expect(result).toEqual({ workers: 1, reviewers: 0, skipped: 1 });
    expect(logged.join(" ")).toMatch(/could not ask w1 to stop/);
  });

  it("asks a running Worker and Reviewer that carry no bm.role label, by their provider (delta 20260918g)", async () => {
    const { paseo, sends } = daemonWith({
      agents: [
        worker("w-plain", { labels: {}, provider: "bm-worker/claude-opus-5" }),
        reviewer("rev-plain", { labels: { "paseo.parent-agent-id": WORKER }, provider: "bm-reviewer/gpt-5.6-sol" }),
        worker("claude-1", { labels: {}, provider: "claude" }),
      ],
    });
    const result = await stopAllInWorkspace(paseo as never, WS);
    expect(result).toEqual({ workers: 1, reviewers: 1, skipped: 0 });
    expect(sends).toEqual(
      expect.arrayContaining([
        { id: "w-plain", text: WORKER_STOP_NOTICE },
        { id: "rev-plain", text: REVIEWER_STOP_NOTICE },
      ]),
    );
    expect(sends).toHaveLength(2);
  });

  it("never asks a Manager, labelled or recognised only by its bm-manager provider", async () => {
    const { paseo, sends } = daemonWith({
      agents: [
        managerAgent("m-labelled"),
        { id: "m-plain", workspaceId: WS, status: "running", labels: {}, provider: "bm-manager/claude-opus-5" },
        worker("w1"),
      ],
    });
    const result = await stopAllInWorkspace(paseo as never, WS);
    expect(sends.map((s) => s.id)).toEqual(["w1"]);
    expect(result).toEqual({ workers: 1, reviewers: 0, skipped: 0 });
  });

  it("never asks the Orchestrator's assessment agent, labelled or recognised only by its provider (orchestrator design §3.2)", async () => {
    const { paseo, sends, refreshes } = daemonWith({
      agents: [
        { id: "orc-labelled", workspaceId: WS, status: "running", labels: { "bm.role": "orchestrator" }, provider: "bm-orchestrator" },
        { id: "orc-plain", workspaceId: WS, status: "running", labels: {}, provider: "bm-orchestrator/claude-opus-5" },
        worker("w1"),
      ],
    });
    const result = await stopAllInWorkspace(paseo as never, WS);
    expect(sends.map((s) => s.id)).toEqual(["w1"]);
    expect(result).toEqual({ workers: 1, reviewers: 0, skipped: 0 });
    expect(refreshes).not.toContain("orc-labelled");
    expect(refreshes).not.toContain("orc-plain");
  });

  it("walks every page", async () => {
    // The fake pages two at a time; five agents means three pages.
    const { paseo, sends } = daemonWith({
      agents: [worker("w1"), worker("w2"), worker("w3"), worker("w4"), worker("w5")],
    });
    const result = await stopAllInWorkspace(paseo as never, WS);
    expect(result.workers).toBe(5);
    expect(sends).toHaveLength(5);
  });
});
