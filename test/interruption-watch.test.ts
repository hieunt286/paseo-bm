import { describe, expect, it, vi } from "vitest";
import {
  INTERRUPTED_KIND,
  INTERRUPT_COOLDOWN_MS,
  createInterruptionWatch,
  interruptedNoticeText,
  isPaseoInterruption,
  type InterruptionWatchDeps,
} from "../plugin/server/interruption-watch";
import type { TraceRecord } from "../plugin/shared/contracts";
import { MANAGER, WORKER, at, msg, turn } from "./fixtures/orchestrator-traces";
import { fakePaseo, type FakeAgent } from "./helpers/fake-paseo";

/**
 * ADR-024: a turn Paseo cut short to deliver a message is told apart from the
 * owner's stop by structure only — a canceled turn, a next turn that starts at
 * once, no owner-typed message, no owner deny — and the agent left idle with
 * nothing of its own running gets one BM-INTERRUPTED. The field case of
 * 2026-10-01: the Manager's cancel_agent was cut by its Worker's finish notice.
 */

const runtime = (provider: string) => ({ model: "m", thinkingOptionId: null, modeId: null, provider }) as unknown as TraceRecord["runtime"];
const cut = (agentId = MANAGER, role: TraceRecord["role"] = "manager") =>
  turn({ agentId, role, turnId: "t-20", startedAt: at(54, 50), endedAt: at(55, 0), outcome: "canceled", runtime: runtime(`bm-${role}`) });
const after = (agentId = MANAGER, role: TraceRecord["role"] = "manager", extra: Partial<TraceRecord> = {}) =>
  turn({ agentId, role, turnId: "t-21", startedAt: at(55, 0), endedAt: at(55, 5), outcome: "completed", runtime: runtime(`bm-${role}`), ...extra });

const agent = (id: string, provider: string, status: string, labels: Record<string, string> = {}): FakeAgent => ({
  id,
  provider,
  status,
  workspaceId: "wks_1",
  labels,
  createdAt: at(0),
});

function setup(agents: FakeAgent[], deps: Partial<InterruptionWatchDeps> = {}) {
  const fake = fakePaseo({ agents });
  const sent: Array<{ target: string; kind: string; text: string }> = [];
  const timers: Array<() => void> = [];
  let clock = Date.parse(at(55, 5));
  const watch = createInterruptionWatch({
    now: () => clock,
    log: () => {},
    baseProvider: async () => "claude",
    setTimer: (run) => timers.push(run),
    enqueue: async (target, kind, text) => {
      sent.push({ target, kind, text });
      return "sent";
    },
    ...deps,
  });
  const fire = async () => {
    for (const run of timers.splice(0)) run();
    await watch.settled();
  };
  return { watch, fake, sent, fire, advance: (ms: number) => (clock += ms) };
}

describe("isPaseoInterruption (pure)", () => {
  const previous = { outcome: "canceled" as const, startedAt: at(54, 50), endedAt: at(55, 0) };

  it("a canceled turn followed at once by a turn without an owner message, with no deny, is Paseo's", () => {
    expect(isPaseoInterruption(previous, after(), [])).toBe(true);
    // Field gaps run from −0.8 s to +2 s.
    expect(isPaseoInterruption(previous, after(MANAGER, "manager", { startedAt: at(54, 59) }), [])).toBe(true);
  });

  it("the owner's own stop or message, or a deny, is never Paseo's", () => {
    // No turn starts by itself after the owner's Stop: the next one comes much later.
    expect(isPaseoInterruption(previous, after(MANAGER, "manager", { startedAt: at(57, 0) }), [])).toBe(false);
    // The owner typed a new message that replaced the turn.
    expect(isPaseoInterruption(previous, after(MANAGER, "manager", { sent: [msg(MANAGER, at(55, 0), "stop that", "user")] }), [])).toBe(false);
    // The owner denied a permission in that turn.
    expect(isPaseoInterruption(previous, after(), [Date.parse(at(54, 58))])).toBe(false);
    // A turn that completed was not cut.
    expect(isPaseoInterruption({ ...previous, outcome: "completed" }, after(), [])).toBe(false);
    expect(isPaseoInterruption(undefined, after(), [])).toBe(false);
  });

  it("an agent's message in the new turn does not make it the owner's", () => {
    expect(isPaseoInterruption(previous, after(MANAGER, "manager", { sent: [msg(MANAGER, at(55, 0), "BM-REPORT ...", "agent")] }), [])).toBe(true);
  });
});

describe("the watch", () => {
  it("tells a Manager left idle that the cut was not the owner's: once, through the notice queue", async () => {
    const { watch, fake, sent, fire } = setup([
      agent(MANAGER, "bm-manager", "idle"),
      agent(WORKER, "bm-worker", "idle", { "paseo.parent-agent-id": MANAGER, "bm.role": "worker" }),
    ]);
    watch.turnRecorded(cut(), fake.paseo);
    watch.turnRecorded(after(), fake.paseo);
    await fire();
    expect(sent).toEqual([{ target: MANAGER, kind: INTERRUPTED_KIND, text: interruptedNoticeText(at(55, 0)) }]);
    expect(sent[0]!.text.startsWith("BM-INTERRUPTED\ncutAt: ")).toBe(true);
    // The same records read again send nothing more (cooldown).
    watch.turnRecorded(cut(), fake.paseo);
    watch.turnRecorded(after(), fake.paseo);
    await fire();
    expect(sent).toHaveLength(1);
  });

  it("sends nothing to an agent that went on: it runs, an agent it created runs, or it started another turn", async () => {
    const running = setup([agent(MANAGER, "bm-manager", "running")]);
    running.watch.turnRecorded(cut(), running.fake.paseo);
    running.watch.turnRecorded(after(), running.fake.paseo);
    await running.fire();
    expect(running.sent).toEqual([]);

    const child = setup([
      agent(MANAGER, "bm-manager", "idle"),
      agent(WORKER, "bm-worker", "running", { "paseo.parent-agent-id": MANAGER, "bm.role": "worker" }),
    ]);
    child.watch.turnRecorded(cut(), child.fake.paseo);
    child.watch.turnRecorded(after(), child.fake.paseo);
    await child.fire();
    expect(child.sent).toEqual([]);

    const moved = setup([agent(MANAGER, "bm-manager", "idle")]);
    moved.watch.turnRecorded(cut(), moved.fake.paseo);
    moved.watch.turnRecorded(after(), moved.fake.paseo);
    moved.watch.turnStarted(MANAGER);
    await moved.fire();
    expect(moved.sent).toEqual([]);
  });

  it("an owner's deny of the agent keeps it silent; another agent's deny does not", async () => {
    const denied = setup([agent(MANAGER, "bm-manager", "idle")]);
    denied.watch.turnRecorded(cut(), denied.fake.paseo);
    denied.watch.permissionResolved({ agent: { id: MANAGER }, requestId: "r1", resolution: { behavior: "deny" } });
    denied.watch.turnRecorded(after(), denied.fake.paseo);
    await denied.fire();
    expect(denied.sent).toEqual([]);

    const other = setup([agent(MANAGER, "bm-manager", "idle")]);
    other.watch.turnRecorded(cut(), other.fake.paseo);
    other.watch.permissionResolved({ agent: { id: WORKER }, requestId: "r1", resolution: { behavior: "deny" } });
    other.watch.permissionResolved({ agent: { id: MANAGER }, requestId: "r2", resolution: { behavior: "allow" } });
    other.watch.turnRecorded(after(), other.fake.paseo);
    await other.fire();
    expect(other.sent).toHaveLength(1);
  });

  it("only Managers and Workers on claude or codex: never a Reviewer, never OpenCode", async () => {
    const reviewer = setup([agent("rev-1", "bm-reviewer", "idle")]);
    reviewer.watch.turnRecorded(cut("rev-1", "reviewer"), reviewer.fake.paseo);
    reviewer.watch.turnRecorded(after("rev-1", "reviewer"), reviewer.fake.paseo);
    await reviewer.fire();
    expect(reviewer.sent).toEqual([]);

    const opencode = setup([agent(WORKER, "bm-worker", "idle")], { baseProvider: async () => "opencode" });
    opencode.watch.turnRecorded(cut(WORKER, "worker"), opencode.fake.paseo);
    opencode.watch.turnRecorded(after(WORKER, "worker"), opencode.fake.paseo);
    await opencode.fire();
    expect(opencode.sent).toEqual([]);

    const codex = setup([agent(WORKER, "bm-worker", "idle")], { baseProvider: async () => "codex" });
    codex.watch.turnRecorded(cut(WORKER, "worker"), codex.fake.paseo);
    codex.watch.turnRecorded(after(WORKER, "worker"), codex.fake.paseo);
    await codex.fire();
    expect(codex.sent.map((entry) => entry.target)).toEqual([WORKER]);
  });

  it("a second cut after the cooldown is told again; a failure is a log line, never a throw", async () => {
    const { watch, fake, sent, fire, advance } = setup([agent(MANAGER, "bm-manager", "idle")]);
    watch.turnRecorded(cut(), fake.paseo);
    watch.turnRecorded(after(), fake.paseo);
    await fire();
    advance(INTERRUPT_COOLDOWN_MS);
    watch.turnRecorded(cut(), fake.paseo);
    watch.turnRecorded(after(), fake.paseo);
    await fire();
    expect(sent).toHaveLength(2);

    const log = vi.fn();
    const broken = setup([agent(MANAGER, "bm-manager", "idle")], { log, baseProvider: async () => Promise.reject(new Error("config down")) });
    broken.watch.turnRecorded(cut(), broken.fake.paseo);
    broken.watch.turnRecorded(after(), broken.fake.paseo);
    await broken.fire();
    expect(broken.sent).toEqual([]);
    expect(String(log.mock.calls[0]?.[0])).toContain("config down");
  });
});
