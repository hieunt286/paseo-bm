import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBindingStore } from "../plugin/server/agent-bindings";
import { createNoticeQueue } from "../plugin/server/notice-queue";
import { isPluginNotice } from "../plugin/server/notices";
import { childFactLine, childFactLines, notifyChildFactChange, settingsNotice, type SettingsPaseo } from "../plugin/server/settings-notices";
import { reviewCallsOf } from "../plugin/server/traces";
import type { TraceRecord } from "../plugin/shared/contracts";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * Delta 20260921 §4.3.5 (REQ-064 d): after a save that changes a child role's
 * Runtime-facts line, every live agent that creates that child gets the new
 * line as BM-SETTINGS, through the notice queue. Fake agents only.
 */

type Agent = { id: string; provider: string; labels?: Record<string, string>; archivedAt?: string | null; status: string; workspaceId?: string | null };

/** The shared fake SDK holding copies of these agents: tests change an agent's status, and the fixtures are shared. */
function daemonWith(fixtures: Agent[]) {
  const fake = fakePaseo<SettingsPaseo>({ agents: fixtures });
  return { ...fake, list: fake.api.agents.list };
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
  const modes = (lists: Record<string, unknown[]>, config: Record<string, unknown> = { agentProfiles: [] }) => fakePaseo({ providers: { modes: lists }, config }).paseo;

  it("is the line the creator's Runtime facts carry: the Manager's for a Worker save, the Worker's for a Reviewer save", async () => {
    const paseo = modes({ "bm-worker": [{ id: "build", label: "Build" }], "bm-reviewer": [] });
    expect(await childFactLine("worker", paseo)).toBe(WORKER_LINE);
    expect(await childFactLine("reviewer", paseo)).toBe(REVIEWER_LINE);
  });

  // Design delta 20260924-instruction-quality §3: the Manager's facts also carry a
  // `Worker skills` line, which is not a role setting and never rides a BM-SETTINGS.
  it("is only the mode line when the Manager's facts also name the Worker's skills", async () => {
    const paseo = modes({ "bm-worker": [{ id: "build", label: "Build" }] }, { agentProfiles: [], providers: { "bm-worker": { extends: "claude" } } });
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
    // A bm.role label alone makes no Manager or Worker (design §16.3): never told.
    { id: "label-only-manager", provider: "claude", labels: { "bm.role": "manager" }, status: "idle" },
    { id: "label-only-worker", provider: "codex", labels: { "bm.role": "worker" }, status: "idle" },
  ];

  it("sends a changed Worker line now to an idle Manager and at its turn end to a running one; never to archived agents or other roles", async () => {
    const queue = createNoticeQueue({ log: () => {} });
    const fake = daemonWith([...MANAGERS, ...WORKERS, ...OTHERS]);
    const notified = await notifyChildFactChange("worker", WORKER_LINE, NEW_WORKER_LINE, fake.paseo, { enqueue: queue.enqueue });
    expect(notified).toBe(2);
    expect(fake.sends).toEqual([{ id: "m-idle", text: settingsNotice(NEW_WORKER_LINE) }]);
    expect(queue.pending("m-busy")).toEqual([{ kind: "BM-SETTINGS", text: settingsNotice(NEW_WORKER_LINE) }]);
    expect(queue.pending("m-archived")).toEqual([]);

    fake.agents.find((agent) => agent.id === "m-busy")!.status = "idle";
    await queue.turnEnded({ agent: { id: "m-busy" } }, fake.paseo);
    expect(fake.sends.map((entry) => entry.id)).toEqual(["m-idle", "m-busy"]);
  });

  it("sends a changed Reviewer line to every live Worker, fallback Workers too", async () => {
    const queue = createNoticeQueue({ log: () => {} });
    const fake = daemonWith([...MANAGERS, ...WORKERS, ...OTHERS]);
    expect(await notifyChildFactChange("reviewer", "", REVIEWER_LINE, fake.paseo, { enqueue: queue.enqueue })).toBe(2);
    expect(fake.sends).toEqual([{ id: "w-1", text: settingsNotice(REVIEWER_LINE) }]);
    expect(queue.pending("w-fallback")).toHaveLength(1);
  });

  it("lets a newer BM-SETTINGS replace the one still queued for a running agent", async () => {
    const queue = createNoticeQueue({ log: () => {} });
    const fake = daemonWith([MANAGERS[1]!]);
    await notifyChildFactChange("worker", WORKER_LINE, NEW_WORKER_LINE, fake.paseo, { enqueue: queue.enqueue });
    await notifyChildFactChange("worker", NEW_WORKER_LINE, WORKER_LINE, fake.paseo, { enqueue: queue.enqueue });
    expect(queue.pending("m-busy")).toEqual([{ kind: "BM-SETTINGS", text: settingsNotice(WORKER_LINE) }]);
  });

  it("sends nothing when the line did not change, when there is none, or for a Manager save", async () => {
    const enqueue = vi.fn();
    const fake = daemonWith([...MANAGERS, ...WORKERS]);
    expect(await notifyChildFactChange("worker", WORKER_LINE, WORKER_LINE, fake.paseo, { enqueue })).toBe(0);
    expect(await notifyChildFactChange("worker", WORKER_LINE, "", fake.paseo, { enqueue })).toBe(0);
    expect(await notifyChildFactChange("manager", null, null, fake.paseo, { enqueue })).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(fake.list).not.toHaveBeenCalled();
  });

  it("does nothing for an Orchestrator save, and never tells an Orchestrator agent about another role's line (orchestrator design §3.2)", async () => {
    const orchestrators: Agent[] = [
      { id: "o-labelled", provider: "bm-orchestrator", labels: { "bm.role": "orchestrator" }, status: "idle" },
      { id: "o-plain", provider: "bm-orchestrator/claude-opus-5", status: "idle" },
    ];
    const enqueue = vi.fn(async () => "sent" as const);
    const fake = daemonWith([...MANAGERS, ...WORKERS, ...orchestrators]);
    expect(await childFactLine("orchestrator", fake.paseo)).toBeNull();
    expect(await notifyChildFactChange("orchestrator", "", "Orchestrator mode: `auto`", fake.paseo, { enqueue })).toBe(0);
    expect(fake.list).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    // A Worker or Reviewer line reaches its creators only.
    await notifyChildFactChange("worker", WORKER_LINE, NEW_WORKER_LINE, fake.paseo, { enqueue });
    await notifyChildFactChange("reviewer", "", REVIEWER_LINE, fake.paseo, { enqueue });
    expect(enqueue.mock.calls.map((call) => (call as unknown[])[0])).toEqual(["m-idle", "m-busy", "w-1", "w-fallback"]);
  });

  it("skips a bound creator, whose Runtime facts carry no child mode line (design §16.12); unbound ones are still told", async () => {
    const queue = createNoticeQueue({ log: () => {} });
    const fake = daemonWith([...MANAGERS, ...WORKERS]);
    const bound = new Set(["m-idle", "w-fallback"]);
    const isBound = vi.fn((agentId: string) => bound.has(agentId));
    expect(await notifyChildFactChange("worker", WORKER_LINE, NEW_WORKER_LINE, fake.paseo, { enqueue: queue.enqueue, isBound })).toBe(1);
    expect(fake.sends).toEqual([]);
    expect(queue.pending("m-idle")).toEqual([]);
    expect(queue.pending("m-busy")).toEqual([{ kind: "BM-SETTINGS", text: settingsNotice(NEW_WORKER_LINE) }]);
    expect(await notifyChildFactChange("reviewer", "", REVIEWER_LINE, fake.paseo, { enqueue: queue.enqueue, isBound })).toBe(1);
    expect(fake.sends).toEqual([{ id: "w-1", text: settingsNotice(REVIEWER_LINE) }]);
    expect(queue.pending("w-fallback")).toEqual([]);
  });

  it("reads who is bound from the data folder's binding store by default: a bound or revoked binding, never a pending one", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-settings-notices-"));
    const previous = process.env["PASEO_BM_HOME"];
    process.env["PASEO_BM_HOME"] = join(root, "data");
    try {
      const bindings = createBindingStore(join(root, "data"));
      const { token, tokenSha256 } = bindings.issue({ role: "manager", workspaceId: "wks_1", creationTools: true });
      bindings.attach(token, "manager");
      bindings.settle(tokenSha256, "m-idle");
      bindings.issue({ role: "manager", workspaceId: "wks_1", creationTools: true });
      const enqueue = vi.fn(async () => "sent" as const);
      const fake = daemonWith([...MANAGERS]);
      expect(await notifyChildFactChange("worker", WORKER_LINE, NEW_WORKER_LINE, fake.paseo, { enqueue })).toBe(1);
      expect(enqueue.mock.calls.map((call) => (call as unknown[])[0])).toEqual(["m-busy"]);
    } finally {
      if (previous === undefined) delete process.env["PASEO_BM_HOME"];
      else process.env["PASEO_BM_HOME"] = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never throws: a failed agent list costs one log line and notifies nobody", async () => {
    const log = vi.fn();
    const fake = daemonWith([]);
    fake.list.mockRejectedValueOnce(new Error("daemon busy"));
    expect(await notifyChildFactChange("worker", WORKER_LINE, NEW_WORKER_LINE, fake.paseo, { log })).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[paseo-bm\] .*daemon busy/);
  });
});

/**
 * Live check 2026-10-01 F4: after the Worker moved from Claude to Codex, the
 * Manager of a project whose action boundary is on was told `full-access`.
 * Each creator is told the line of its own project (change-010 C5).
 */
describe("the BM-SETTINGS line follows the creator's project boundary (live check 2026-10-01 F4)", () => {
  const CODEX_MODES = [
    { id: "auto", label: "Auto", colorTier: "moderate" },
    { id: "auto-review", label: "Auto review", colorTier: "moderate" },
    { id: "full-access", label: "Full access", colorTier: "dangerous" },
  ];
  const codex = () =>
    fakePaseo({
      providers: { modes: { "bm-worker": CODEX_MODES, "bm-reviewer": CODEX_MODES } },
      config: { agentProfiles: [], providers: { "bm-worker": { extends: "codex" }, "bm-reviewer": { extends: "codex" } } },
    }).paseo;
  const workerLine = (mode: string) => `Worker mode: \`${mode}\` — pass it as \`settings.modeId\` when you create a Worker.`;
  const reviewerLine = (mode: string) => `Reviewer mode: \`${mode}\` — pass it as \`settings.modeId\` when you create a Reviewer.`;

  it("childFactLine is the boundary mode in a project whose boundary is on, today's mode elsewhere", async () => {
    const paseo = codex();
    expect(await childFactLine("worker", paseo, undefined, "on")).toBe(workerLine("auto"));
    expect(await childFactLine("worker", paseo, undefined, "off")).toBe(workerLine("full-access"));
    expect(await childFactLine("worker", paseo)).toBe(workerLine("full-access"));
    expect(await childFactLines("reviewer", paseo)).toEqual({ on: reviewerLine("auto"), off: reviewerLine("auto") });
    expect(await childFactLines("manager", paseo)).toBeNull();
  });

  it("the live case: the Manager of the on project is told auto, the Manager of the off project full-access", async () => {
    const queue = createNoticeQueue({ log: () => {} });
    const fake = daemonWith([
      { id: "m-on", provider: "bm-manager", labels: { "bm.role": "manager" }, status: "idle", workspaceId: "wks-on" },
      { id: "m-off", provider: "bm-manager", labels: { "bm.role": "manager" }, status: "idle", workspaceId: "wks-off" },
      { id: "m-nowhere", provider: "bm-manager", labels: { "bm.role": "manager" }, status: "idle", workspaceId: null },
    ]);
    // Before the save the Worker was Claude: `default` under the boundary, `bypassPermissions` elsewhere.
    const before = { on: workerLine("default"), off: workerLine("bypassPermissions") };
    const after = await childFactLines("worker", codex());
    const boundaryOn = vi.fn((workspaceId: string) => workspaceId === "wks-on");
    expect(await notifyChildFactChange("worker", before, after, fake.paseo, { enqueue: queue.enqueue, boundaryOn })).toBe(3);
    expect(fake.sends).toEqual([
      { id: "m-on", text: settingsNotice(workerLine("auto")) },
      { id: "m-off", text: settingsNotice(workerLine("full-access")) },
      { id: "m-nowhere", text: settingsNotice(workerLine("full-access")) },
    ]);
  });

  it("tells only the side whose line changed, and reads no policy when both sides say the same", async () => {
    const enqueue = vi.fn(async () => "sent" as const);
    const fake = daemonWith([
      { id: "m-on", provider: "bm-manager", labels: { "bm.role": "manager" }, status: "idle", workspaceId: "wks-on" },
      { id: "m-off", provider: "bm-manager", labels: { "bm.role": "manager" }, status: "idle", workspaceId: "wks-off" },
    ]);
    const boundaryOn = vi.fn((workspaceId: string) => workspaceId === "wks-on");
    const before = { on: workerLine("auto"), off: workerLine("bypassPermissions") };
    expect(await notifyChildFactChange("worker", before, { on: workerLine("auto"), off: workerLine("full-access") }, fake.paseo, { enqueue, boundaryOn })).toBe(1);
    expect(enqueue.mock.calls.map((call) => (call as unknown[])[0])).toEqual(["m-off"]);
    const same = vi.fn(() => true);
    await notifyChildFactChange("worker", { on: WORKER_LINE, off: WORKER_LINE }, { on: NEW_WORKER_LINE, off: NEW_WORKER_LINE }, fake.paseo, { enqueue, boundaryOn: same });
    expect(same).not.toHaveBeenCalled();
    expect(await notifyChildFactChange("worker", before, before, fake.paseo, { enqueue, boundaryOn })).toBe(0);
  });
});
