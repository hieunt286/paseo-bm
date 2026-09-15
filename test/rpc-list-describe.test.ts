import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  listWorkspaceAgents,
  type AgentDirectoryPaseo,
  type ListedAgentSnapshot,
} from "../plugin/server/manager";
import { describeRoles } from "../plugin/server/roles";
import contribute, { INSTALL_RECORD_URL, readInstallRecord } from "../plugin/index.server";
import { agentsListRpc, rolesDescribeRpc } from "../plugin/shared/contracts";

/**
 * WP-112 `agents.list` and `roles.describe` against a fake Paseo SDK and an
 * in-memory install record. No daemon, no real HOME.
 */

const WS = "ws-1";

function agent(overrides: Partial<ListedAgentSnapshot> & { id: string }): ListedAgentSnapshot {
  return {
    workspaceId: WS,
    title: overrides.id,
    status: "idle",
    createdAt: "2026-09-15T08:00:00.000Z",
    updatedAt: "2026-09-15T09:00:00.000Z",
    labels: {},
    archivedAt: null,
    ...overrides,
  };
}

function fakeDirectory(agents: ListedAgentSnapshot[], pageSize = 200) {
  const filters: unknown[] = [];
  const paseo: AgentDirectoryPaseo = {
    agents: {
      async list({ filter, page }) {
        filters.push(filter);
        const matching = agents.filter((a) => filter.includeArchived || !a.archivedAt);
        const start = page.cursor ? Number(page.cursor) : 0;
        const slice = matching.slice(start, start + Math.min(pageSize, page.limit));
        const next = start + slice.length;
        const hasMore = next < matching.length;
        return {
          entries: slice.map((a) => ({ agent: { ...a, labels: { ...a.labels } } })),
          pageInfo: { hasMore, nextCursor: hasMore ? String(next) : null },
        };
      },
    },
  };
  return { paseo, filters };
}

const t = (minute: number) => `2026-09-15T08:${String(minute).padStart(2, "0")}:00.000Z`;

describe("agents.list — tree", () => {
  it("full tree: Manager → Worker → Reviewer, parent links and fields preserved", async () => {
    const { paseo, filters } = fakeDirectory([
      agent({ id: "rev", createdAt: t(3), labels: { "bm.role": "reviewer", "paseo.parent-agent-id": "wrk" } }),
      agent({ id: "mgr", createdAt: t(1), title: "Beads Manager", status: "running", labels: { "bm.role": "manager" } }),
      agent({ id: "wrk", createdAt: t(2), labels: { "bm.role": "worker", "paseo.parent-agent-id": "mgr" } }),
    ]);

    const output = await listWorkspaceAgents({ workspaceId: WS }, { paseo });

    expect(agentsListRpc.output.parse(output)).toEqual({
      agents: [
        { id: "mgr", role: "manager", title: "Beads Manager", status: "running", parentId: null, updatedAt: "2026-09-15T09:00:00.000Z" },
        { id: "wrk", role: "worker", title: "wrk", status: "idle", parentId: "mgr", updatedAt: "2026-09-15T09:00:00.000Z" },
        { id: "rev", role: "reviewer", title: "rev", status: "idle", parentId: "wrk", updatedAt: "2026-09-15T09:00:00.000Z" },
      ],
    });
    // No label filter (unlabeled children must be reachable), archived excluded.
    expect(filters).toEqual([{ includeArchived: false }]);
  });

  it("agent with missing or foreign bm.role label: role unknown, no error", async () => {
    const { paseo } = fakeDirectory([
      agent({ id: "mgr", createdAt: t(1), labels: { "bm.role": "manager" } }),
      agent({ id: "wrk", createdAt: t(2), title: null, labels: { "paseo.parent-agent-id": "mgr" } }),
      agent({ id: "rev", createdAt: t(3), labels: { "paseo.parent-agent-id": "wrk" } }),
      agent({ id: "odd", createdAt: t(4), labels: { "bm.role": "planner" } }),
    ]);

    const { agents } = await listWorkspaceAgents({ workspaceId: WS }, { paseo });

    expect(agents.map((a) => [a.id, a.role, a.parentId])).toEqual([
      ["mgr", "manager", null],
      ["wrk", "unknown", "mgr"],
      ["rev", "unknown", "wrk"],
      ["odd", "unknown", null],
    ]);
    expect(agents[1]!.title).toBeNull();
    expect(() => agentsListRpc.output.parse({ agents })).not.toThrow();
  });

  it("orphaned Worker (Manager deleted or archived) still listed as a root with its Reviewer", async () => {
    const { paseo } = fakeDirectory([
      agent({ id: "mgr-archived", createdAt: t(0), archivedAt: t(5), labels: { "bm.role": "manager" } }),
      agent({ id: "wrk-1", createdAt: t(1), labels: { "bm.role": "worker", "paseo.parent-agent-id": "mgr-deleted" } }),
      agent({ id: "wrk-2", createdAt: t(2), labels: { "bm.role": "worker", "paseo.parent-agent-id": "mgr-archived" } }),
      agent({ id: "rev", createdAt: t(3), labels: { "bm.role": "reviewer", "paseo.parent-agent-id": "wrk-1" } }),
    ]);

    const { agents } = await listWorkspaceAgents({ workspaceId: WS }, { paseo });

    expect(agents.map((a) => [a.id, a.role, a.parentId])).toEqual([
      ["wrk-1", "worker", null],
      ["wrk-2", "worker", null],
      ["rev", "reviewer", "wrk-1"],
    ]);
  });

  it("empty list", async () => {
    const { paseo } = fakeDirectory([]);
    expect(await listWorkspaceAgents({ workspaceId: WS }, { paseo })).toEqual({ agents: [] });
  });

  it("keeps only this workspace, skips unrelated unlabeled agents, walks every page", async () => {
    const { paseo, filters } = fakeDirectory(
      [
        agent({ id: "user-agent", createdAt: t(0) }),
        agent({ id: "other-mgr", createdAt: t(1), workspaceId: "ws-2", labels: { "bm.role": "manager" } }),
        agent({ id: "mgr", createdAt: t(2), status: "closed", labels: { "bm.role": "manager" } }),
        agent({ id: "wrk", createdAt: t(3), labels: { "paseo.parent-agent-id": "mgr" } }),
      ],
      1,
    );

    const { agents } = await listWorkspaceAgents({ workspaceId: WS }, { paseo });

    expect(agents.map((a) => [a.id, a.status, a.parentId])).toEqual([
      ["mgr", "closed", null],
      ["wrk", "idle", "mgr"],
    ]);
    expect(filters).toHaveLength(4);
  });
});

function record(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    version: "0.1.0",
    installedAt: "2026-09-15T08:00:00.000Z",
    updatedAt: "2026-09-15T08:00:00.000Z",
    installHome: "/home/u/.paseo-bm",
    paseo: {
      home: "/home/u/.paseo",
      pluginId: "paseo-bm",
      pluginDir: "/home/u/.paseo-bm/plugin/0.1.0",
      pluginsEnabledSetByUs: true,
      mcpInject: { setByUs: true, previous: { present: false, value: null } },
    },
    roles: [
      { role: "reviewer", providerId: "bm-reviewer", profileId: "bm-reviewer", baseProvider: "claude", model: "opus", modeId: null, thinkingOptionId: null, paseoTools: false },
      { role: "manager", providerId: "bm-manager", profileId: "bm-manager", baseProvider: "codex", model: "gpt-5.6-sol", modeId: "full-access", thinkingOptionId: "high", paseoTools: true },
      { role: "worker", providerId: "bm-worker", profileId: "bm-worker", baseProvider: "codex", model: "gpt-5.6-sol", modeId: null, thinkingOptionId: null, paseoTools: true },
    ],
    files: [],
    versions: [
      { version: "0.0.9", dir: "plugin/0.0.9", installedAt: "2026-09-01T08:00:00.000Z", active: false },
      { version: "0.1.0", dir: "plugin/0.1.0", installedAt: "2026-09-15T08:00:00.000Z", active: true },
    ],
    backups: [],
    skills: { agents: [], lastStatus: [], assistDeclinedAt: null, lastCommand: null, assistOutcome: null },
    ...overrides,
  };
}

const fromText = (text: string | null) => ({ readRecord: async () => text });

describe("roles.describe", () => {
  it("returns the three roles from install.json, instructions in the active payload", async () => {
    const output = await describeRoles(fromText(JSON.stringify(record())));

    expect(rolesDescribeRpc.output.parse(output)).toEqual({
      roles: [
        { role: "manager", provider: "codex", model: "gpt-5.6-sol", paseoTools: true, instructionsPath: "/home/u/.paseo-bm/plugin/0.1.0/roles/manager.md" },
        { role: "worker", provider: "codex", model: "gpt-5.6-sol", paseoTools: true, instructionsPath: "/home/u/.paseo-bm/plugin/0.1.0/roles/worker.md" },
        { role: "reviewer", provider: "claude", model: "opus", paseoTools: false, instructionsPath: "/home/u/.paseo-bm/plugin/0.1.0/roles/reviewer.md" },
      ],
    });
  });

  it("no install record: empty roles", async () => {
    expect(await describeRoles(fromText(null))).toEqual({ roles: [] });
  });

  it("record from a newer schema: E_RECORD_SCHEMA_TOO_NEW", async () => {
    await expect(describeRoles(fromText(JSON.stringify(record({ schemaVersion: 2 }))))).rejects.toThrow(
      /^E_RECORD_SCHEMA_TOO_NEW: /,
    );
  });

  it("damaged record: error naming the field", async () => {
    await expect(describeRoles(fromText("{"))).rejects.toThrow(/not valid JSON/);
    const bad = record({ roles: [{ role: "manager", baseProvider: "codex", model: 5, paseoTools: true }] });
    await expect(describeRoles(fromText(JSON.stringify(bad)))).rejects.toThrow(/roles\.0\.model/);
  });
});

describe("plugin server entry — agents.list and roles.describe", () => {
  it("registers both handlers", async () => {
    const handle = vi.fn();
    contribute({ handle } as unknown as Parameters<typeof contribute>[0]);
    const contracts = handle.mock.calls.map(([contract]) => contract);
    expect(contracts).toContain(agentsListRpc);
    expect(contracts).toContain(rolesDescribeRpc);
    expect(contracts.map((c: { name: string }) => c.name).sort()).toEqual([
      "agents.list",
      "manager.ensure",
      "roles.describe",
    ]);

    const listHandler = handle.mock.calls.find(([c]) => c === agentsListRpc)![1];
    const { paseo } = fakeDirectory([agent({ id: "mgr", labels: { "bm.role": "manager" } })]);
    const output = await listHandler({ workspaceId: WS }, { paseo });
    expect(output.agents.map((a: { id: string }) => a.id)).toEqual(["mgr"]);
  });

  it("locates install.json two levels above the payload entry", () => {
    const entry = new URL("../plugin/index.server.ts", import.meta.url);
    expect(INSTALL_RECORD_URL.href).toBe(new URL("../../install.json", entry).href);
  });

  it("reads the record, and returns null when it is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-record-"));
    try {
      const file = join(dir, "install.json");
      expect(await readInstallRecord(pathToFileURL(file))).toBeNull();
      writeFileSync(file, JSON.stringify(record()));
      const text = await readInstallRecord(pathToFileURL(file));
      expect((await describeRoles(fromText(text))).roles).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
