import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { checkWorkerTools, forgetTools, recordTools, toolsNotice, toolsSeen, type ToolsPaseo } from "../plugin/server/tools-check";
import { registerAgentLabels, type AgentLabeller } from "../plugin/server/agent-labels";
import { isPluginNotice } from "../plugin/server/notices";
import { paseoToolsWarnings } from "../plugin/client/setup-model";
import { setupStatusSchema, type SetupStatus } from "../plugin/shared/contracts";

/**
 * Delta 20260921 §4.2.4 (REQ-063 d): a new Worker without Paseo tools — Pi
 * without pi-mcp-adapter — is reported to its Manager with BM-TOOLS, through
 * the notice queue, and shown on the Setup screen.
 */

type Snapshot = { status?: string; provider?: string; labels?: Record<string, string>; capabilities?: { supportsMcpServers?: unknown } };

function fakePaseo(agents: Record<string, Snapshot>): ToolsPaseo {
  return {
    agents: {
      ref: (id: string) => ({
        refresh: async () => (agents[id] === undefined ? null : { agent: agents[id] }),
        send: async () => {},
      }),
    },
  };
}

const MANAGER: Snapshot = { status: "running", provider: "bm-manager", labels: { "bm.role": "manager" } };
const TEXT =
  "BM-TOOLS Worker w-1 runs on bm-worker/qwen without Paseo tools (on Pi this means pi-mcp-adapter is missing). It cannot send you a BM-REPORT or create a Reviewer. Tell the user in one line; do not create another Worker for this request unless the user asks.";

beforeEach(() => forgetTools());

describe("checkWorkerTools", () => {
  it("queues BM-TOOLS for the parent Manager, word for word, when the Worker has no Paseo tools", async () => {
    const enqueue = vi.fn(async () => "queued" as const);
    const paseo = fakePaseo({ "w-1": { capabilities: { supportsMcpServers: false } }, "m-1": MANAGER });
    expect(await checkWorkerTools({ id: "w-1", provider: "bm-worker/qwen", parentAgentId: "m-1" }, paseo, { enqueue })).toBe("missing");
    expect(enqueue).toHaveBeenCalledWith("m-1", "BM-TOOLS", TEXT, paseo);
    expect(toolsNotice("w-1", "bm-worker/qwen")).toBe(TEXT);
    expect(toolsSeen().worker).toMatchObject({ state: "missing", agentId: "w-1", provider: "bm-worker/qwen" });
  });

  it("sends nothing when the Worker has its tools, or when Paseo does not say", async () => {
    const enqueue = vi.fn();
    expect(await checkWorkerTools({ id: "w-1", provider: "bm-worker", parentAgentId: "m-1" }, fakePaseo({ "w-1": { capabilities: { supportsMcpServers: true } }, "m-1": MANAGER }), { enqueue })).toBe("ok");
    expect(await checkWorkerTools({ id: "w-2", provider: "bm-worker", parentAgentId: "m-1" }, fakePaseo({ "w-2": {}, "m-1": MANAGER }), { enqueue })).toBe("unknown");
    expect(enqueue).not.toHaveBeenCalled();
    expect(toolsSeen().worker?.state).toBe("unknown");
  });

  it("tells nobody when the parent is not a Beads Manager, or there is none, and logs it", async () => {
    const enqueue = vi.fn();
    const log = vi.fn();
    const paseo = fakePaseo({ "w-1": { capabilities: { supportsMcpServers: false } }, "x-1": { provider: "claude", labels: {} } });
    await checkWorkerTools({ id: "w-1", provider: "bm-worker", parentAgentId: "x-1" }, paseo, { enqueue, log });
    await checkWorkerTools({ id: "w-1", provider: "bm-worker", parentAgentId: null }, paseo, { enqueue, log });
    expect(enqueue).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("never throws: a failing refresh costs one log line", async () => {
    const log = vi.fn();
    const hostile = { agents: { ref: () => ({ refresh: async () => { throw new Error("gone"); }, send: async () => {} }) } } as ToolsPaseo;
    expect(await checkWorkerTools({ id: "w-1", provider: "bm-worker" }, hostile, { log })).toBe("unknown");
    expect(log).toHaveBeenCalledWith("[paseo-bm] checking the Paseo tools of w-1 failed: gone");
  });

  it("is a plugin notice, so it is never taken for the user's words", () => {
    expect(isPluginNotice(TEXT)).toBe(true);
  });
});

describe("agent.created runs the check for Workers only", () => {
  it("checks a new bm-worker, not a Reviewer or a Manager, and survives a broken event", async () => {
    const handlers: Record<string, (event: unknown, context: unknown) => Promise<void>> = {};
    const host = { on: vi.fn((name: string, handler: (event: unknown, context: unknown) => Promise<void>) => ((handlers[name] = handler), () => {})) };
    const labeller = { labelAgent: vi.fn(async () => {}), scanOnce: vi.fn(async () => {}) } as unknown as AgentLabeller;
    registerAgentLabels(host as never, labeller);
    const refreshed: string[] = [];
    const paseo = {
      agents: {
        ref: (id: string) => ({
          refresh: async () => (refreshed.push(id), { agent: { capabilities: { supportsMcpServers: true } } }),
          send: async () => {},
        }),
      },
    };
    await handlers["agent.created"]!({ agent: { id: "w-1", provider: "bm-worker/claude-opus-5", parentAgentId: "m-1" } }, { paseo });
    await handlers["agent.created"]!({ agent: { id: "r-1", provider: "bm-reviewer", parentAgentId: "w-1" } }, { paseo });
    await handlers["agent.created"]!({ agent: { id: "m-1", provider: "bm-manager", parentAgentId: null } }, { paseo });
    // Only the Worker's tools are checked; the Reviewer is read once, for its
    // bm.replaces label (delta 20260921 §4.5.1), and the Manager not at all.
    expect(refreshed).toEqual(["w-1", "r-1"]);
    expect(toolsSeen().worker?.state).toBe("ok");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(handlers["agent.created"]!(null, { paseo })).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe("setup.status paseoTools and the Setup screen warning", () => {
  const base = {
    tools: [],
    latestCheckedOn: "2026-09-16",
    skills: {
      checkedAt: "2026-09-22T00:00:00.000Z",
      dirs: { shared: "~/.agents/skills", claude: "~/.claude/skills", codex: "~/.codex/skills" },
      skills: [],
      missingRequired: { claude: 0, codex: 0 },
      installCommand: "npx skills add cuongntr/agent-skills",
    },
    extras: { manager: 0, worker: 0, reviewer: 0 },
  };

  it("parses a payload without paseoTools (older server) and one with it", () => {
    expect(setupStatusSchema.parse(base).paseoTools).toBeUndefined();
    const withTools = { ...base, paseoTools: { manager: null, worker: recordTools("worker", "w-9", "bm-worker/qwen", false, "2026-09-22T01:00:00.000Z") } };
    expect(setupStatusSchema.parse(withTools)).toEqual(withTools);
  });

  it("warns once per role whose last new agent had no Paseo tools", () => {
    const status = {
      ...base,
      paseoTools: {
        manager: { state: "ok", agentId: "m-1", provider: "bm-manager", at: "t" },
        worker: { state: "missing", agentId: "w-9", provider: "bm-worker/qwen", at: "t" },
      },
    } as SetupStatus;
    expect(paseoToolsWarnings(status)).toEqual([
      "The last Worker (w-9) runs on bm-worker/qwen without Paseo tools, so it cannot create or message other agents. On Pi, install the pi-mcp-adapter extension.",
    ]);
    expect(paseoToolsWarnings(base as SetupStatus)).toEqual([]);
  });

  // Design delta 20260924-instruction-quality §2.1: the notice itself tells the
  // Manager what to do; manager.md hands every BM- message to the message.
  it("tells the Manager, in the notice itself, what BM-TOOLS means", () => {
    expect(toolsNotice("w-1", "pi")).toContain("Tell the user in one line; do not create another Worker for this request unless the user asks.");
    const manager = readFileSync(new URL("../plugin/roles/manager.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(manager).toContain("The plugin's notices — messages that start with `BM-FORMAT`, `BM-BUDGET`, `BM-TOOLS`");
  });
});
