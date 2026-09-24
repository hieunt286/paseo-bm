import { describe, expect, it, vi } from "vitest";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { isPluginNotice } from "../plugin/server/notices";
import { childFactLine, notifyChildFactChange, settingsNotice, type SettingsPaseo } from "../plugin/server/settings-notices";
import { reviewCallsOf } from "../plugin/server/traces";
import type { TraceRecord } from "../plugin/shared/contracts";

/**
 * Delta 20260921 §4.3.5 (REQ-064 d): after a save that changes a child role's
 * Runtime-facts line, every live agent that creates that child gets the new
 * line as BM-SETTINGS, through the notice queue. Fake agents only.
 */

type Agent = { id: string; provider: string; labels?: Record<string, string>; archivedAt?: string | null; status: string };

function fakePaseo(fixtures: Agent[]) {
  // A copy: tests change an agent's status, and the fixtures are shared.
  const agents = structuredClone(fixtures);
  const sent: Array<{ id: string; text: string }> = [];
  const list = vi.fn(async () => ({ entries: agents.map((agent) => ({ agent })) }));
  const paseo: SettingsPaseo = {
    agents: {
      list,
      ref: (id: string) => ({
        refresh: async () => {
          const agent = agents.find((entry) => entry.id === id);
          return agent === undefined ? null : { agent };
        },
        send: async (text: string) => {
          sent.push({ id, text });
        },
      }),
    },
  };
  return { paseo, sent, list, agents };
}

const WORKER_LINE = "Worker mode: `build` — pass it as `settings.modeId` when you create a Worker.";
const NEW_WORKER_LINE = "Worker mode: `bypassPermissions` — pass it as `settings.modeId` when you create a Worker.";
const REVIEWER_LINE = "Reviewer mode: none — do not pass `settings.modeId` when you create a Reviewer; Paseo sets it.";

describe("settingsNotice", () => {
  it("is the text of the design, word for word, and a plugin notice", () => {
    expect(settingsNotice(NEW_WORKER_LINE)).toBe(
      [
        'BM-SETTINGS The user changed the paseo-bm role settings. This replaces the matching line under "## Runtime facts":',
        NEW_WORKER_LINE,
        "Do not reply to this message; carry on with what you were doing.",
      ].join("\n"),
    );
    expect(isPluginNotice(settingsNotice(NEW_WORKER_LINE))).toBe(true);
  });

  it("is never counted as a review call when it reaches a Reviewer", () => {
    const record = { agentId: "rev", sent: [{ agentId: null, at: "", text: settingsNotice(REVIEWER_LINE), truncated: false }] } as unknown as TraceRecord;
    expect(reviewCallsOf(["rev"], [record])).toBe(0);
  });
});

describe("childFactLine", () => {
  const modes = (lists: Record<string, unknown[]>) => ({
    providers: { listModes: async (provider: string) => ({ provider, modes: lists[provider] ?? [], error: null }) },
    config: { get: async () => ({ config: { agentProfiles: [] } }) },
  });

  it("is the line the creator's Runtime facts carry: the Manager's for a Worker save, the Worker's for a Reviewer save", async () => {
    const paseo = modes({ "bm-worker": [{ id: "build", label: "Build" }], "bm-reviewer": [] });
    expect(await childFactLine("worker", paseo)).toBe(WORKER_LINE);
    expect(await childFactLine("reviewer", paseo)).toBe(REVIEWER_LINE);
  });

  // Design delta 20260924-instruction-quality §3: the Manager's facts also carry a
  // `Worker skills` line, which is not a role setting and never rides a BM-SETTINGS.
  it("is only the mode line when the Manager's facts also name the Worker's skills", async () => {
    const paseo = {
      ...modes({ "bm-worker": [{ id: "build", label: "Build" }] }),
      config: { get: async () => ({ config: { agentProfiles: [], providers: { "bm-worker": { extends: "claude" } } } }) },
    };
    expect(await childFactLine("worker", paseo)).toBe(WORKER_LINE);
  });

  it("is null for a Manager save (nobody creates Managers), and '' when there is no line", async () => {
    expect(await childFactLine("manager", modes({}))).toBeNull();
    expect(await childFactLine("worker", {})).toBe("");
  });
});

describe("notifyChildFactChange", () => {
  const MANAGERS: Agent[] = [
    { id: "m-idle", provider: "bm-manager", labels: { "bm.role": "manager" }, status: "idle" },
    { id: "m-busy", provider: "bm-manager/claude-opus-5", status: "running" },
    { id: "m-archived", provider: "bm-manager", labels: { "bm.role": "manager" }, status: "idle", archivedAt: "2026-09-20T00:00:00.000Z" },
  ];
  const WORKERS: Agent[] = [
    { id: "w-1", provider: "bm-worker", labels: { "bm.role": "worker" }, status: "idle" },
    { id: "w-fallback", provider: "bm-worker-fallback-1/qwen", labels: { "bm.role": "worker" }, status: "running" },
  ];
  const OTHERS: Agent[] = [
    { id: "r-1", provider: "bm-reviewer", labels: { "bm.role": "reviewer" }, status: "idle" },
    { id: "mine", provider: "claude", status: "idle" },
  ];

  it("sends a changed Worker line now to an idle Manager and at its turn end to a running one; never to archived agents or other roles", async () => {
    const queue = createNoticeQueue({ log: () => {} });
    const fake = fakePaseo([...MANAGERS, ...WORKERS, ...OTHERS]);
    const notified = await notifyChildFactChange("worker", WORKER_LINE, NEW_WORKER_LINE, fake.paseo, { enqueue: queue.enqueue });
    expect(notified).toBe(2);
    expect(fake.sent).toEqual([{ id: "m-idle", text: settingsNotice(NEW_WORKER_LINE) }]);
    expect(queue.pending("m-busy")).toEqual([{ kind: "BM-SETTINGS", text: settingsNotice(NEW_WORKER_LINE) }]);
    expect(queue.pending("m-archived")).toEqual([]);

    fake.agents.find((agent) => agent.id === "m-busy")!.status = "idle";
    await queue.turnEnded({ agent: { id: "m-busy" } }, fake.paseo);
    expect(fake.sent.map((entry) => entry.id)).toEqual(["m-idle", "m-busy"]);
  });

  it("sends a changed Reviewer line to every live Worker, fallback Workers too", async () => {
    const queue = createNoticeQueue({ log: () => {} });
    const fake = fakePaseo([...MANAGERS, ...WORKERS, ...OTHERS]);
    expect(await notifyChildFactChange("reviewer", "", REVIEWER_LINE, fake.paseo, { enqueue: queue.enqueue })).toBe(2);
    expect(fake.sent).toEqual([{ id: "w-1", text: settingsNotice(REVIEWER_LINE) }]);
    expect(queue.pending("w-fallback")).toHaveLength(1);
  });

  it("lets a newer BM-SETTINGS replace the one still queued for a running agent", async () => {
    const queue = createNoticeQueue({ log: () => {} });
    const fake = fakePaseo([MANAGERS[1]!]);
    await notifyChildFactChange("worker", WORKER_LINE, NEW_WORKER_LINE, fake.paseo, { enqueue: queue.enqueue });
    await notifyChildFactChange("worker", NEW_WORKER_LINE, WORKER_LINE, fake.paseo, { enqueue: queue.enqueue });
    expect(queue.pending("m-busy")).toEqual([{ kind: "BM-SETTINGS", text: settingsNotice(WORKER_LINE) }]);
  });

  it("sends nothing when the line did not change, when there is none, or for a Manager save", async () => {
    const enqueue = vi.fn();
    const fake = fakePaseo([...MANAGERS, ...WORKERS]);
    expect(await notifyChildFactChange("worker", WORKER_LINE, WORKER_LINE, fake.paseo, { enqueue })).toBe(0);
    expect(await notifyChildFactChange("worker", WORKER_LINE, "", fake.paseo, { enqueue })).toBe(0);
    expect(await notifyChildFactChange("manager", null, null, fake.paseo, { enqueue })).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(fake.list).not.toHaveBeenCalled();
  });

  it("never throws: a failed agent list costs one log line and notifies nobody", async () => {
    const log = vi.fn();
    const fake = fakePaseo([]);
    fake.list.mockRejectedValueOnce(new Error("daemon busy"));
    expect(await notifyChildFactChange("worker", WORKER_LINE, NEW_WORKER_LINE, fake.paseo, { log })).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[paseo-bm\] .*daemon busy/);
  });
});
