import { describe, expect, it, vi } from "vitest";
import { listAllAgents, roleOfAgent, roleOfProvider } from "../plugin/server/agent-role";
import { handleChatPeers } from "../plugin/server/chat-rpc";
import { handleChatWaiting } from "../plugin/server/chat-waiting";
import { bmAgentsOf, type DashboardPaseo } from "../plugin/server/dashboard-rpc";
import { FALLBACK_ROLES, fallbackAlias, fallbackAliasOf, positionOfAlias } from "../plugin/shared/fallback";

/**
 * Which paseo-bm role an agent has (delta 20260918g §4.1–§4.2, REQ-061 a).
 * The cases come from the owner's "Refactor Dependency" workspace: its Manager
 * was started from Paseo's new-agent flow with the Manager profile and carries
 * no label at all, so every lookup that filtered on `bm.role` missed it.
 */

const MANAGER_ID = "f13a4e4e-18b6-4369-91c8-70c61460ef2d";
const WORKER_ID = "9467dc77-8afb-4e9e-9177-a17dcf8e10b3";
const WORKSPACE = "wks_ef81bbe0663d91ca";
const REQ = "req-20260918T070348Z";

type Agent = Record<string, unknown> & { id: string; labels: Record<string, string> };

/** The two agents of that workspace, as `list_agents` showed them on 2026-09-18. */
const refactorDependency = (): Agent[] => [
  {
    id: MANAGER_ID,
    workspaceId: WORKSPACE,
    provider: "bm-manager",
    status: "idle",
    title: "Hãy pull code mới nhất từ branch dev về",
    labels: {},
  },
  {
    id: WORKER_ID,
    workspaceId: WORKSPACE,
    provider: "bm-worker",
    status: "idle",
    title: "Remove @cmc-dx/* deps (keep core) + AGENTS.md",
    labels: { "bm.role": "worker", "bm.requestId": REQ, "paseo.parent-agent-id": MANAGER_ID },
  },
];

/**
 * A daemon directory: applies a labels filter only when one is given, and
 * pages like the real one (at most `page.limit` entries, a cursor after).
 */
function directory(agents: Agent[], timelines: Record<string, unknown[]> = {}): DashboardPaseo & { calls: number } {
  const fake = {
    calls: 0,
    agents: {
      list: vi.fn(async (options: { filter: { labels?: Record<string, string> }; page: { limit: number; cursor?: string } }) => {
        fake.calls += 1;
        const wanted = options.filter.labels;
        const matching = agents.filter(
          (agent) => wanted === undefined || Object.entries(wanted).every(([key, value]) => agent.labels[key] === value),
        );
        const start = options.page.cursor === undefined ? 0 : Number(options.page.cursor);
        const end = start + options.page.limit;
        return {
          entries: matching.slice(start, end).map((agent) => ({ agent })),
          pageInfo: { hasMore: end < matching.length, nextCursor: end < matching.length ? String(end) : null },
        };
      }),
      ref: (agentId: string) => ({
        timeline: { refetch: vi.fn(async () => ({ entries: [...(timelines[agentId] ?? [])], hasOlder: false })) },
      }),
    },
    workspaces: { list: vi.fn(async () => ({ entries: [] })) },
    config: { get: vi.fn(async () => ({ config: {} })) },
  };
  return fake;
}

describe("roleOfAgent", () => {
  it("takes a valid bm.role label first", () => {
    expect(roleOfAgent({ labels: { "bm.role": "reviewer" }, provider: "bm-worker" })).toEqual({ role: "reviewer", labelled: true });
  });

  it("falls back to the provider when the label is missing or unknown", () => {
    expect(roleOfAgent({ labels: {}, provider: "bm-manager" })).toEqual({ role: "manager", labelled: false });
    expect(roleOfAgent({ labels: { "bm.role": "boss" }, provider: "bm-worker/claude-opus-5" })).toEqual({
      role: "worker",
      labelled: false,
    });
    expect(roleOfAgent({ provider: "bm-reviewer/gpt-5.6-sol" })).toEqual({ role: "reviewer", labelled: false });
  });

  it("returns null for any other agent and for malformed input, without throwing", () => {
    expect(roleOfAgent({ labels: {}, provider: "claude" })).toBeNull();
    expect(roleOfAgent({ labels: { "bm.role": "manager-ish" }, provider: "codex/gpt-5.4" })).toBeNull();
    expect(roleOfAgent({ provider: "constructor" })).toBeNull();
    for (const bad of [null, undefined, 42, "bm-worker", { labels: "x", provider: 7 }]) {
      expect(roleOfAgent(bad)).toBeNull();
    }
  });
});

describe("fallback aliases (delta 20260921 §4.4.1, REQ-065 f)", () => {
  it("run the role in their name, with or without a model, positions 1 to 3 only", () => {
    expect(roleOfProvider("bm-worker-fallback-2/x")).toBe("worker");
    expect(roleOfProvider("bm-reviewer-fallback-3")).toBe("reviewer");
    expect(roleOfProvider("bm-manager-fallback-1/anthropic/claude-sonnet-4-6")).toBe("manager");
    for (const other of ["bm-worker-fallback-4", "bm-worker-fallback-0", "bm-worker-fallback-", "bm-boss-fallback-1", "bm-worker-fallback-1x", "xbm-worker-fallback-1"]) {
      expect(roleOfProvider(other)).toBeNull();
    }
  });

  it("leave the three main aliases as they were", () => {
    expect(roleOfProvider("bm-manager")).toBe("manager");
    expect(roleOfProvider("bm-worker/claude-opus-5")).toBe("worker");
    expect(roleOfProvider("bm-reviewer/gpt-5.6-sol")).toBe("reviewer");
    expect(roleOfProvider("claude")).toBeNull();
    expect(roleOfProvider(undefined)).toBeNull();
  });

  it("give an unlabelled agent on a fallback alias its role", () => {
    expect(roleOfAgent({ labels: {}, provider: "bm-worker-fallback-1/qwen" })).toEqual({ role: "worker", labelled: false });
  });

  it("are named and read back by the shared helpers; the main alias is position 0", () => {
    expect(fallbackAlias("worker", 2)).toBe("bm-worker-fallback-2");
    expect(() => fallbackAlias("worker", 4)).toThrow(RangeError);
    expect(fallbackAliasOf("bm-reviewer-fallback-3")).toEqual({ role: "reviewer", position: 3 });
    expect(fallbackAliasOf("bm-reviewer-fallback-3/gpt")).toBeNull();
    expect(positionOfAlias("bm-worker")).toBe(0);
    expect(positionOfAlias("bm-worker-fallback-1")).toBe(1);
    expect(positionOfAlias("claude")).toBeNull();
    // Phase 2a-16 offered the Worker's chain; 2a-17 adds the Reviewer's and the Manager's.
    expect(FALLBACK_ROLES).toEqual(["worker", "reviewer", "manager"]);
  });
});

describe("listAllAgents", () => {
  it("walks every page", async () => {
    const agents = Array.from({ length: 450 }, (_, n): Agent => ({ id: `a${n}`, labels: {} }));
    const paseo = directory(agents);
    const all = await listAllAgents((options) => paseo.agents.list(options) as never, { includeArchived: true });
    expect(all).toHaveLength(450);
    expect(paseo.calls).toBe(3);
  });

  it("stops at a page without pageInfo", async () => {
    const list = vi.fn(async () => ({ entries: [{ agent: { id: "a" } }, { agent: { id: "b" } }] }));
    expect(await listAllAgents(list, {})).toEqual([{ id: "a" }, { id: "b" }]);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe("bmAgentsOf", () => {
  it("finds agents by label and by provider, and marks which is which", async () => {
    const found = await bmAgentsOf(directory([...refactorDependency(), { id: "x", provider: "claude", labels: {} }]));
    expect(found.map((entry) => [entry.facts.id, entry.facts.role, entry.facts.labelled])).toEqual([
      [MANAGER_ID, "manager", false],
      [WORKER_ID, "worker", true],
    ]);
  });

  it("returns more than 200 agents of one role (the old single page stopped at 200)", async () => {
    const workers = Array.from({ length: 201 }, (_, n): Agent => ({
      id: `w${n}`,
      workspaceId: "wks_a",
      provider: "bm-worker",
      status: "idle",
      labels: { "bm.role": "worker" },
    }));
    const paseo = directory(workers);
    const found = await bmAgentsOf(paseo);
    expect(found).toHaveLength(201);
    expect(found.at(-1)?.facts.id).toBe("w200");
    // Negative control: one page of 200 filtered on the label, as before this delta.
    const onePage = await paseo.agents.list({ filter: { labels: { "bm.role": "worker" }, includeArchived: true }, page: { limit: 200 } });
    expect(onePage.entries).toHaveLength(200);
  });

  it("is empty when the directory cannot be read", async () => {
    const paseo = directory([]);
    paseo.agents.list = vi.fn(async () => {
      throw new Error("daemon gone");
    });
    expect(await bmAgentsOf(paseo)).toEqual([]);
  });
});

describe("chat.peers with the Refactor Dependency agents", () => {
  const home = { homedir: () => "/nonexistent-bm-home" };

  it("gives the unlabelled Manager's chat an owner, so its cards are drawn", async () => {
    const result = await handleChatPeers({ agentId: MANAGER_ID }, directory(refactorDependency()), home);
    expect(result.owner).toMatchObject({ id: MANAGER_ID, role: "manager", labelled: false });
    expect(result.peers).toEqual([expect.objectContaining({ id: WORKER_ID, role: "worker", labelled: true, requestId: REQ })]);
    expect(result.workspaceId).toBe(WORKSPACE);
  });

  it("lets the Worker's chat see its Manager", async () => {
    const result = await handleChatPeers({ agentId: WORKER_ID }, directory(refactorDependency()), home);
    expect(result.owner).toMatchObject({ id: WORKER_ID, parentId: MANAGER_ID, labelled: true });
    expect(result.peers.map((peer) => [peer.id, peer.role, peer.labelled])).toEqual([[MANAGER_ID, "manager", false]]);
  });
});

describe("chat.waiting with an unlabelled Manager", () => {
  it("lists the Worker that waits in that Manager's chat", async () => {
    const asking = [
      "BM-REPORT",
      `requestId: ${REQ}`,
      "phase: blocked",
      "tier: Large (changed: no)",
      "filesChanged: none",
      "beadsCreated: none",
      "beadsUpdated: none",
      "beadsClosed: none",
      "beadsReady: none",
      "reviewFindingsOpen: none",
      "buildAndTests: not run",
      "skillsUsed: feature-workflow",
      "blockers: 1 question: Q1 — see BM-QUESTIONS",
      "",
      "BM-QUESTIONS",
      `requestId: ${REQ}`,
      "Q1: Cách thay thế 7 gói @cmc-dx.",
      "- a: Mirror vào libs. (recommended)",
      "- b: Port vào kit nội bộ.",
    ].join("\n");
    const timelines = { [MANAGER_ID]: [{ item: { type: "user_message", text: asking }, timestamp: "2026-09-18T07:06:00.000Z" }] };
    const result = await handleChatWaiting(directory(refactorDependency(), timelines), { homedir: () => "/nonexistent-bm-home" });
    expect(result.waiting.map((entry) => [entry.managerId, entry.workerId, entry.requestId])).toEqual([[MANAGER_ID, WORKER_ID, REQ]]);
  });
});
