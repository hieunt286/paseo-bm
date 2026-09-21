import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contribute from "../plugin/index.server";
import {
  createNoticeQueue,
  enqueue,
  noticeQueue,
  registerNoticeQueue,
  type NoticeHost,
  type NoticePaseo,
} from "../plugin/server/notice-queue";

/**
 * The shared notice queue (delta 20260921 §4.2.4, F13; bead
 * bm-phase-2a-14-any-provider-u2g9.11). A fake Paseo: scripted agent
 * snapshots for `refresh()`, and a record of every `send()`. Like the real
 * daemon, a send starts a turn, so the fake marks its target `running`. No
 * daemon, no `paseo`, no real `$HOME`.
 */

const realHome = process.env.HOME;
const isolatedHome = mkdtempSync(join(tmpdir(), "bm-notice-queue-home-"));
beforeAll(() => {
  process.env.HOME = isolatedHome;
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

type Agent = { status: string; archivedAt?: string | null };

function world(initial: Record<string, Agent>) {
  const agents = new Map(Object.entries(initial).map(([id, agent]) => [id, { ...agent }]));
  const sends: Array<{ id: string; text: string }> = [];
  const refreshes: string[] = [];
  const failing = new Set<string>();
  const paseo: NoticePaseo = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          refreshes.push(id);
          const agent = agents.get(id);
          return agent === undefined ? null : { agent: { ...agent } };
        },
        send: async (text: string) => {
          if (failing.has(text)) throw new Error("daemon said no");
          sends.push({ id, text });
          agents.set(id, { ...agents.get(id)!, status: "running" });
        },
      }),
    },
  };
  const set = (id: string, change: Partial<Agent>) => agents.set(id, { ...agents.get(id)!, ...change });
  const logs: string[] = [];
  const queue = createNoticeQueue({ log: (message) => logs.push(message) });
  const turnEnded = (id: string, turnId = "foreground-turn-1") =>
    queue.turnEnded(
      {
        agent: { id, workspaceId: "ws-1", parentAgentId: null, provider: "bm-manager", cwd: "/repo", title: null },
        turnId,
        outcome: { kind: "completed" },
        timeline: [],
      },
      paseo,
    );
  return { paseo, sends, refreshes, failing, set, logs, queue, turnEnded };
}

const texts = (sends: Array<{ id: string; text: string }>) => sends.map((send) => `${send.id}:${send.text}`);

describe("enqueue", () => {
  it("sends at once to an idle target, after reading it", async () => {
    const { paseo, sends, refreshes, logs, queue } = world({ mgr: { status: "idle" } });
    await expect(queue.enqueue("mgr", "BM-TOOLS", "BM-TOOLS Worker wrk …", paseo)).resolves.toBe("sent");
    expect(refreshes).toEqual(["mgr"]);
    expect(texts(sends)).toEqual(["mgr:BM-TOOLS Worker wrk …"]);
    expect(queue.pending("mgr")).toEqual([]);
    expect(logs).toEqual([]);
  });

  it.each(["running", "initializing"])("holds the notice for a %s target and sends it at that target's next turn end", async (status) => {
    const { paseo, sends, set, queue, turnEnded } = world({ mgr: { status }, wrk: { status: "idle" } });
    await expect(queue.enqueue("mgr", "BM-TOOLS", "tools", paseo)).resolves.toBe("queued");
    expect(sends).toEqual([]);
    expect(queue.pending("mgr")).toEqual([{ kind: "BM-TOOLS", text: "tools" }]);

    // Another agent's turn end is no chance for it.
    await turnEnded("wrk");
    expect(sends).toEqual([]);

    set("mgr", { status: "idle" });
    await turnEnded("mgr");
    expect(texts(sends)).toEqual(["mgr:tools"]);
    expect(queue.pending("mgr")).toEqual([]);
  });

  it("keeps the notice when the target still reads running at its turn end, and sends it at the following one", async () => {
    const { paseo, sends, set, queue, turnEnded } = world({ mgr: { status: "running" } });
    await queue.enqueue("mgr", "BM-SETTINGS", "settings", paseo);
    await turnEnded("mgr");
    expect(sends).toEqual([]);
    expect(queue.pending("mgr")).toHaveLength(1);

    set("mgr", { status: "idle" });
    await turnEnded("mgr");
    expect(texts(sends)).toEqual(["mgr:settings"]);
  });

  it("keys by agent id, not turn id: a reused turn id is still a new chance", async () => {
    const { paseo, sends, set, queue, turnEnded } = world({ mgr: { status: "running" } });
    await queue.enqueue("mgr", "BM-TOOLS", "tools", paseo);
    await turnEnded("mgr", "foreground-turn-1");
    set("mgr", { status: "idle" });
    await turnEnded("mgr", "foreground-turn-1");
    expect(texts(sends)).toEqual(["mgr:tools"]);
  });

  it("sends only the newer text when one kind is queued twice", async () => {
    const { paseo, sends, set, queue, turnEnded } = world({ mgr: { status: "running" } });
    const first = queue.enqueue("mgr", "BM-SETTINGS", "old settings", paseo);
    await expect(first).resolves.toBe("queued");
    await expect(queue.enqueue("mgr", "BM-SETTINGS", "new settings", paseo)).resolves.toBe("queued");
    expect(queue.pending("mgr")).toEqual([{ kind: "BM-SETTINGS", text: "new settings" }]);

    set("mgr", { status: "idle" });
    await turnEnded("mgr");
    set("mgr", { status: "idle" });
    await turnEnded("mgr");
    expect(texts(sends)).toEqual(["mgr:new settings"]);
  });

  it("reports a notice replaced while its target was being read as replaced", async () => {
    const { paseo, sends, set, queue, turnEnded } = world({ mgr: { status: "running" } });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: NoticePaseo = {
      agents: {
        ref: (id) => ({
          refresh: async () => {
            await gate;
            return paseo.agents.ref(id).refresh();
          },
          send: (text) => paseo.agents.ref(id).send(text),
        }),
      },
    };
    const first = queue.enqueue("mgr", "BM-SETTINGS", "old", slow);
    await expect(queue.enqueue("mgr", "BM-SETTINGS", "new", slow)).resolves.toBe("queued");
    release();
    await expect(first).resolves.toBe("replaced");
    set("mgr", { status: "idle" });
    await turnEnded("mgr");
    expect(texts(sends)).toEqual(["mgr:new"]);
  });

  it("sends two kinds in order, one per idle moment, so the second never replaces the turn the first started", async () => {
    const { paseo, sends, set, queue, turnEnded } = world({ mgr: { status: "running" } });
    await queue.enqueue("mgr", "BM-TOOLS", "tools", paseo);
    await queue.enqueue("mgr", "BM-FALLBACK", "fallback", paseo);

    set("mgr", { status: "idle" });
    await turnEnded("mgr");
    expect(texts(sends)).toEqual(["mgr:tools"]);
    expect(queue.pending("mgr")).toEqual([{ kind: "BM-FALLBACK", text: "fallback" }]);

    // The notice's own turn is still running: nothing more yet.
    await turnEnded("mgr");
    expect(texts(sends)).toEqual(["mgr:tools"]);

    set("mgr", { status: "idle" });
    await turnEnded("mgr");
    expect(texts(sends)).toEqual(["mgr:tools", "mgr:fallback"]);
  });

  it("moves a replacing notice behind the other kinds already queued", async () => {
    const { paseo, sends, set, queue, turnEnded } = world({ mgr: { status: "running" } });
    await queue.enqueue("mgr", "BM-SETTINGS", "settings 1", paseo);
    await queue.enqueue("mgr", "BM-TOOLS", "tools", paseo);
    await queue.enqueue("mgr", "BM-SETTINGS", "settings 2", paseo);
    expect(queue.pending("mgr").map((notice) => notice.text)).toEqual(["tools", "settings 2"]);
    for (let round = 0; round < 2; round += 1) {
      set("mgr", { status: "idle" });
      await turnEnded("mgr");
    }
    expect(texts(sends)).toEqual(["mgr:tools", "mgr:settings 2"]);
  });

  it("replaces only within one target", async () => {
    const { paseo, sends, set, queue, turnEnded } = world({ mgr: { status: "running" }, wrk: { status: "running" } });
    await queue.enqueue("mgr", "BM-SETTINGS", "for the Manager", paseo);
    await queue.enqueue("wrk", "BM-SETTINGS", "for the Worker", paseo);
    set("mgr", { status: "idle" });
    set("wrk", { status: "idle" });
    await turnEnded("wrk");
    await turnEnded("mgr");
    expect(texts(sends)).toEqual(["wrk:for the Worker", "mgr:for the Manager"]);
  });

  it("keeps order when a new notice arrives for an idle target that still has an older one queued", async () => {
    const { paseo, sends, set, queue, turnEnded } = world({ mgr: { status: "running" } });
    await queue.enqueue("mgr", "BM-TOOLS", "older", paseo);
    // The turn end was missed (for example: it still read running then); the target is idle now.
    set("mgr", { status: "idle" });
    await expect(queue.enqueue("mgr", "BM-FALLBACK", "newer", paseo)).resolves.toBe("queued");
    expect(texts(sends)).toEqual(["mgr:older"]);
    set("mgr", { status: "idle" });
    await turnEnded("mgr");
    expect(texts(sends)).toEqual(["mgr:older", "mgr:newer"]);
  });

  it("logs and drops a notice whose send fails, never throwing, and tries the next one at once", async () => {
    const { paseo, sends, set, failing, logs, queue, turnEnded } = world({ mgr: { status: "running" } });
    failing.add("tools");
    await queue.enqueue("mgr", "BM-TOOLS", "tools", paseo);
    await queue.enqueue("mgr", "BM-SETTINGS", "settings", paseo);
    set("mgr", { status: "idle" });
    await expect(turnEnded("mgr")).resolves.toBeUndefined();
    expect(texts(sends)).toEqual(["mgr:settings"]);
    expect(queue.pending("mgr")).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[paseo-bm\] could not send the BM-TOOLS notice to mgr: daemon said no; dropped it\.$/);
  });

  it("returns dropped, with one log line, when the send of an idle target fails", async () => {
    const { paseo, failing, logs, queue } = world({ mgr: { status: "idle" } });
    failing.add("tools");
    await expect(queue.enqueue("mgr", "BM-TOOLS", "tools", paseo)).resolves.toBe("dropped");
    expect(queue.pending("mgr")).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.startsWith("[paseo-bm] ")).toBe(true);
  });

  it("keeps the notice, with one log line, when the target cannot be read", async () => {
    const { paseo, sends, logs, queue, turnEnded } = world({ mgr: { status: "idle" } });
    const broken: NoticePaseo = {
      agents: {
        ref: (id) => ({
          refresh: async () => {
            throw new Error("socket closed");
          },
          send: (text) => paseo.agents.ref(id).send(text),
        }),
      },
    };
    await expect(queue.enqueue("mgr", "BM-TOOLS", "tools", broken)).resolves.toBe("queued");
    expect(sends).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[paseo-bm\] could not read mgr to deliver its BM-TOOLS notice: socket closed;/);

    // The next turn end brings a working handle.
    await turnEnded("mgr");
    expect(texts(sends)).toEqual(["mgr:tools"]);
  });

  it.each([
    ["archived", { status: "idle", archivedAt: "2026-09-21T10:00:00.000Z" }],
    ["closed", { status: "closed" }],
  ])("never sends to an %s target: its notices are dropped with one log line (ADR-005)", async (_name, agent) => {
    const { paseo, sends, logs, queue } = world({ mgr: agent });
    await expect(queue.enqueue("mgr", "BM-TOOLS", "tools", paseo)).resolves.toBe("dropped");
    expect(sends).toEqual([]);
    expect(queue.pending("mgr")).toEqual([]);
    expect(logs).toEqual(["[paseo-bm] mgr is archived, closed or gone; dropped its queued notices (BM-TOOLS)."]);
  });

  it("drops the queued notices of a target that is gone by its turn end", async () => {
    const { paseo, sends, logs, queue, turnEnded } = world({ mgr: { status: "running" } });
    await queue.enqueue("mgr", "BM-TOOLS", "tools", paseo);
    await queue.enqueue("mgr", "BM-SETTINGS", "settings", paseo);
    const gone: NoticePaseo = { agents: { ref: () => ({ refresh: async () => null, send: async () => {} }) } };
    await queue.turnEnded({ agent: { id: "mgr" } }, gone);
    expect(sends).toEqual([]);
    expect(queue.pending("mgr")).toEqual([]);
    expect(logs).toEqual(["[paseo-bm] mgr is archived, closed or gone; dropped its queued notices (BM-TOOLS, BM-SETTINGS)."]);
    await turnEnded("mgr");
    expect(sends).toEqual([]);
  });

  it.each([
    ["no target", "", "BM-TOOLS", "tools"],
    ["no kind", "mgr", " ", "tools"],
    ["no text", "mgr", "BM-TOOLS", ""],
    ["a target that is not a string", 42 as unknown as string, "BM-TOOLS", "tools"],
  ])("drops a notice with %s, with one log line and no Paseo call", async (_name, target, kind, text) => {
    const { paseo, refreshes, logs, queue } = world({ mgr: { status: "idle" } });
    await expect(queue.enqueue(target, kind, text, paseo)).resolves.toBe("dropped");
    expect(refreshes).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.startsWith("[paseo-bm] ")).toBe(true);
  });

  it("without any Paseo handle yet, holds the notice for the target's turn end, whose context brings one", async () => {
    const { sends, refreshes, queue, turnEnded } = world({ mgr: { status: "idle" } });
    await expect(queue.enqueue("mgr", "BM-TOOLS", "tools")).resolves.toBe("queued");
    expect(refreshes).toEqual([]);
    await turnEnded("mgr");
    expect(texts(sends)).toEqual(["mgr:tools"]);
  });

  it("uses the last handle a hook gave it when the caller passes none", async () => {
    const { sends, set, queue, turnEnded } = world({ mgr: { status: "running" }, wrk: { status: "idle" } });
    await turnEnded("wrk");
    set("mgr", { status: "idle" });
    await expect(queue.enqueue("mgr", "BM-TOOLS", "tools")).resolves.toBe("sent");
    expect(texts(sends)).toEqual(["mgr:tools"]);
  });

  it("does not touch Paseo at a turn end of an agent with nothing queued", async () => {
    const { refreshes, turnEnded } = world({ mgr: { status: "idle" } });
    await turnEnded("mgr");
    expect(refreshes).toEqual([]);
  });

  it.each([
    ["undefined event", undefined],
    ["empty event", {}],
    ["event without an agent id", { agent: {} }],
    ["null agent", { agent: null }],
  ])("never throws on a malformed turn end (%s)", async (_name, event) => {
    const { paseo, sends, queue } = world({ mgr: { status: "running" } });
    await queue.enqueue("mgr", "BM-TOOLS", "tools", paseo);
    await expect(queue.turnEnded(event, paseo)).resolves.toBeUndefined();
    await expect(queue.turnEnded(event, undefined)).resolves.toBeUndefined();
    expect(sends).toEqual([]);
  });

  it("sends once when two turn ends of the target are handled at once", async () => {
    const { paseo, sends, set, queue } = world({ mgr: { status: "running" } });
    await queue.enqueue("mgr", "BM-TOOLS", "tools", paseo);
    set("mgr", { status: "idle" });
    const event = { agent: { id: "mgr" } };
    await Promise.all([queue.turnEnded(event, paseo), queue.turnEnded(event, paseo)]);
    expect(texts(sends)).toEqual(["mgr:tools"]);
  });

  it("takes one more look when the target's turn ends while a read of it is still pending", async () => {
    const { paseo, sends, set, queue } = world({ mgr: { status: "running" } });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const slow: NoticePaseo = {
      agents: {
        ref: (id) => ({
          refresh: async () => {
            reads += 1;
            // The first read answers late, with the status from before the turn ended.
            if (reads === 1) {
              const stale = await paseo.agents.ref(id).refresh();
              await gate;
              return stale;
            }
            return paseo.agents.ref(id).refresh();
          },
          send: (text) => paseo.agents.ref(id).send(text),
        }),
      },
    };
    const pending = queue.enqueue("mgr", "BM-TOOLS", "tools", slow);
    await vi.waitFor(() => expect(reads).toBe(1));
    set("mgr", { status: "idle" });
    await queue.turnEnded({ agent: { id: "mgr" } }, slow);
    release();
    await expect(pending).resolves.toBe("sent");
    expect(texts(sends)).toEqual(["mgr:tools"]);
  });

  it("forgets everything on clear()", async () => {
    const { paseo, sends, set, queue, turnEnded } = world({ mgr: { status: "running" } });
    await queue.enqueue("mgr", "BM-TOOLS", "tools", paseo);
    queue.clear();
    expect(queue.pending("mgr")).toEqual([]);
    set("mgr", { status: "idle" });
    await turnEnded("mgr");
    expect(sends).toEqual([]);
  });
});

type OnHandler = (event: unknown, context: { paseo: unknown; signal: AbortSignal }) => unknown;

function fakeHost() {
  const hooks = new Map<string, OnHandler[]>();
  const on = vi.fn((name: string, handler: OnHandler) => {
    hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    return () => {
      const left = (hooks.get(name) ?? []).filter((entry) => entry !== handler);
      if (left.length === 0) hooks.delete(name);
      else hooks.set(name, left);
    };
  });
  return { host: { on } as unknown as NoticeHost, on, hooks };
}

const context = (paseo: unknown) => ({ paseo, signal: new AbortController().signal });

describe("registerNoticeQueue", () => {
  it("rides on the turn_ended hook registered through its host, after that hook's handler", async () => {
    const { paseo, sends, set, queue } = world({ mgr: { status: "running" } });
    const { host, on, hooks } = fakeHost();
    const registration = registerNoticeQueue(host, queue);
    const order: string[] = [];
    const remove = registration.host.on!("agent.turn_ended", async () => {
      order.push(`handler saw ${sends.length} sends`);
    });
    expect(on).toHaveBeenCalledTimes(1);
    expect(hooks.get("agent.turn_ended")).toHaveLength(1);

    await queue.enqueue("mgr", "BM-TOOLS", "tools", paseo);
    set("mgr", { status: "idle" });
    await hooks.get("agent.turn_ended")![0]!({ agent: { id: "mgr" } }, context(paseo));
    expect(order).toEqual(["handler saw 0 sends"]);
    expect(texts(sends)).toEqual(["mgr:tools"]);

    remove();
    expect(hooks.size).toBe(0);
  });

  it("passes every other registration through untouched", () => {
    const { host, on, hooks } = fakeHost();
    const registration = registerNoticeQueue(host, createNoticeQueue());
    const handler = vi.fn();
    registration.host.on!("agent.created", handler);
    expect(on).toHaveBeenCalledWith("agent.created", handler);
    expect(hooks.get("agent.created")).toEqual([handler]);
  });

  it("still delivers when the handler it rides on fails, and lets that failure through unchanged", async () => {
    const { paseo, sends, set, queue } = world({ mgr: { status: "running" } });
    const { host, hooks } = fakeHost();
    registerNoticeQueue(host, queue).host.on!("agent.turn_ended", async () => {
      throw new Error("handler broke");
    });
    await queue.enqueue("mgr", "BM-TOOLS", "tools", paseo);
    set("mgr", { status: "idle" });
    await expect(Promise.resolve(hooks.get("agent.turn_ended")![0]!({ agent: { id: "mgr" } }, context(paseo)))).rejects.toThrow(
      "handler broke",
    );
    expect(texts(sends)).toEqual(["mgr:tools"]);
  });

  it("remove() detaches the queue and forgets what it holds", async () => {
    const { paseo, sends, set, queue } = world({ mgr: { status: "running" } });
    const { host, hooks } = fakeHost();
    const registration = registerNoticeQueue(host, queue);
    registration.host.on!("agent.turn_ended", () => {});
    await queue.enqueue("mgr", "BM-TOOLS", "tools", paseo);
    registration.remove();
    expect(queue.pending("mgr")).toEqual([]);
    await queue.enqueue("mgr", "BM-SETTINGS", "settings", paseo);
    set("mgr", { status: "idle" });
    await hooks.get("agent.turn_ended")![0]!({ agent: { id: "mgr" } }, context(paseo));
    expect(sends).toEqual([]);
  });

  it("hands back a host without on() unchanged; enqueue still reaches an idle target", async () => {
    const { paseo, sends, queue } = world({ mgr: { status: "idle" } });
    const bare: NoticeHost = {};
    const registration = registerNoticeQueue(bare, queue);
    expect(registration.host).toBe(bare);
    expect(() => registration.remove()).not.toThrow();
    await expect(queue.enqueue("mgr", "BM-TOOLS", "tools", paseo)).resolves.toBe("sent");
    expect(texts(sends)).toEqual(["mgr:tools"]);
  });
});

describe("the server entry", () => {
  it("delivers the shared queue at a turn end without adding a lifecycle hook, and clears it on cleanup", async () => {
    noticeQueue.clear();
    const hooks = new Map<string, OnHandler[]>();
    const on = vi.fn((name: string, handler: OnHandler) => {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      return () => {
        const left = (hooks.get(name) ?? []).filter((entry) => entry !== handler);
        if (left.length === 0) hooks.delete(name);
        else hooks.set(name, left);
      };
    });
    const server = { handle: vi.fn(), registerSettings: vi.fn(), before: vi.fn(() => () => {}), on };
    const cleanup = contribute(server as unknown as Parameters<typeof contribute>[0]);
    // Unchanged by the queue: stop propagation, BM-FORMAT and the collector.
    expect(hooks.get("agent.turn_ended")).toHaveLength(3);

    // A non-bm agent, so every other hook ignores the turn end without touching Paseo.
    const { paseo, sends, set } = world({ "agent-1": { status: "running" } });
    await expect(enqueue("agent-1", "BM-TOOLS", "tools", paseo)).resolves.toBe("queued");
    set("agent-1", { status: "idle" });
    const event = {
      agent: { id: "agent-1", provider: "claude", workspaceId: "ws-1", parentAgentId: null, cwd: "/repo", title: null },
      turnId: "t-1",
      outcome: { kind: "completed" },
      timeline: [],
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const handler of hooks.get("agent.turn_ended")!) {
        await expect(Promise.resolve(handler(event, context(paseo)))).resolves.toBeUndefined();
      }
    } finally {
      warn.mockRestore();
    }
    expect(texts(sends)).toEqual(["agent-1:tools"]);

    set("agent-1", { status: "running" });
    await enqueue("agent-1", "BM-SETTINGS", "settings", paseo);
    cleanup();
    expect(hooks.size).toBe(0);
    expect(noticeQueue.pending("agent-1")).toEqual([]);
  });
});
