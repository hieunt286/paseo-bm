import { describe, expect, it, vi } from "vitest";
import {
  listWorkspaceAgents,
  type AgentDirectoryPaseo,
  type ListedAgentSnapshot,
} from "../plugin/server/manager";
import { describeRoles, type RolesConfigPaseo } from "../plugin/server/roles";
import contribute from "../plugin/index.server";
import { agentsListRpc, rolesDescribeRpc } from "../plugin/shared/contracts";

/**
 * WP-112 `agents.list` and `roles.describe` against a fake Paseo SDK. Since
 * bm-dnc `roles.describe` reads the daemon configuration in effect
 * (`paseo.config.get()`), not `install.json`. No daemon, no real HOME.
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
        { id: "mgr", role: "manager", title: "Beads Manager", status: "running", parentId: null, updatedAt: "2026-09-15T09:00:00.000Z", labelled: true, replacedBy: null },
        { id: "wrk", role: "worker", title: "wrk", status: "idle", parentId: "mgr", updatedAt: "2026-09-15T09:00:00.000Z", labelled: true, replacedBy: null },
        { id: "rev", role: "reviewer", title: "rev", status: "idle", parentId: "wrk", updatedAt: "2026-09-15T09:00:00.000Z", labelled: true, replacedBy: null },
      ],
    });
    // No label filter (unlabeled children must be reachable), archived excluded.
    expect(filters).toEqual([{ includeArchived: false }]);
  });

  it("names the agent that replaced one, by its bm.replacedBy label or by a switched incident (delta 20260921 §4.4.8)", async () => {
    const { paseo } = fakeDirectory([
      agent({ id: "mgr", createdAt: t(1), labels: { "bm.role": "manager" } }),
      agent({ id: "wrk", createdAt: t(2), labels: { "bm.role": "worker", "paseo.parent-agent-id": "mgr", "bm.replacedBy": "wrk-2" } }),
      agent({ id: "wrk-2", createdAt: t(3), labels: { "bm.role": "worker", "paseo.parent-agent-id": "mgr" } }),
      agent({ id: "rev", createdAt: t(4), labels: { "bm.role": "reviewer", "paseo.parent-agent-id": "wrk" } }),
    ]);
    const { agents } = await listWorkspaceAgents({ workspaceId: WS }, { paseo, replacements: new Map([["rev", "rev-2"]]) });
    expect(agents.map((a) => [a.id, a.replacedBy])).toEqual([
      ["mgr", null],
      ["wrk", "wrk-2"],
      ["wrk-2", null],
      ["rev", "rev-2"],
    ]);
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

  it("a Manager started outside Beads Manager (no labels, bm-manager provider) is a manager root, labelled: false (delta 20260918g)", async () => {
    const { paseo } = fakeDirectory([
      agent({ id: "user-mgr", createdAt: t(1), provider: "bm-manager/claude-opus-5", labels: {} }),
      agent({ id: "wrk", createdAt: t(2), provider: "bm-worker/claude-opus-5", labels: { "bm.role": "worker", "paseo.parent-agent-id": "user-mgr" } }),
      agent({ id: "plain", createdAt: t(3), provider: "claude", labels: {} }),
    ]);

    const { agents } = await listWorkspaceAgents({ workspaceId: WS }, { paseo });

    expect(agents.map((a) => [a.id, a.role, a.parentId, a.labelled])).toEqual([
      ["user-mgr", "manager", null, false],
      ["wrk", "worker", "user-mgr", true],
    ]);
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

type DaemonConfig = Awaited<ReturnType<RolesConfigPaseo["config"]["get"]>>["config"];

/** Daemon config as `paseo.config.get()` returns it, shaped like the installer writes it (ADR-006). */
function daemonConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    providers: {
      claude: { enabled: true },
      "room-worker": { extends: "claude", label: "Room Worker", paseoTools: { enabled: true } },
      "bm-reviewer": { extends: "claude", label: "Beads Reviewer" },
      "bm-manager": { extends: "codex", label: "Beads Manager", paseoTools: { enabled: true } },
      "bm-worker": { extends: "codex", label: "Beads Worker", paseoTools: { enabled: true } },
    },
    agentProfiles: [
      { id: "room-worker", provider: "room-worker", model: "haiku" },
      { id: "bm-reviewer", provider: "bm-reviewer", model: "opus" },
      { id: "bm-manager", provider: "bm-manager", model: "gpt-5.6-sol" },
      { id: "bm-worker", provider: "bm-worker", model: "gpt-5.6-sol" },
    ],
    ...overrides,
  };
}

function fakeConfig(config: DaemonConfig) {
  let reads = 0;
  const paseo: RolesConfigPaseo = {
    config: {
      async get() {
        reads += 1;
        return { config };
      },
    },
  };
  return { paseo, reads: () => reads };
}

describe("roles.describe", () => {
  it("returns the three roles from the Paseo config in effect, in role order, ignoring foreign entries", async () => {
    const fake = fakeConfig(daemonConfig());
    const output = await describeRoles({ paseo: fake.paseo });

    expect(rolesDescribeRpc.output.parse(output)).toEqual({
      roles: [
        { role: "manager", provider: "codex", model: "gpt-5.6-sol", paseoTools: true, instructionsPath: "roles/manager.md" },
        { role: "worker", provider: "codex", model: "gpt-5.6-sol", paseoTools: true, instructionsPath: "roles/worker.md" },
        { role: "reviewer", provider: "claude", model: "opus", paseoTools: false, instructionsPath: "roles/reviewer.md" },
      ],
    });
    expect(fake.reads()).toBe(1);
  });

  it("paseoTools follows the stored {enabled} shape: only enabled === true grants", async () => {
    const { paseo } = fakeConfig(
      daemonConfig({
        providers: {
          "bm-manager": { extends: "codex", paseoTools: { enabled: false } },
          "bm-worker": { extends: "codex", paseoTools: {} },
          "bm-reviewer": { extends: "claude", paseoTools: true },
        },
      }),
    );
    const { roles } = await describeRoles({ paseo });
    expect(roles.map((r) => [r.role, r.paseoTools])).toEqual([
      ["manager", false],
      ["worker", false],
      ["reviewer", false],
    ]);
  });

  it("no bm-* providers or profiles (paseo-bm roles not registered): empty roles", async () => {
    const { paseo } = fakeConfig({ providers: { claude: {} }, agentProfiles: [] });
    expect(await describeRoles({ paseo })).toEqual({ roles: [] });
    const bare = fakeConfig({});
    expect(await describeRoles({ paseo: bare.paseo })).toEqual({ roles: [] });
  });

  it("half-registered role: reports what is there, empty strings for the rest, no error", async () => {
    const { paseo } = fakeConfig({
      providers: { "bm-worker": { label: "Beads Worker", paseoTools: { enabled: true } } },
      agentProfiles: [{ id: "bm-manager", provider: "bm-manager" }],
    });
    expect(await describeRoles({ paseo })).toEqual({
      roles: [
        { role: "manager", provider: "", model: "", paseoTools: false, instructionsPath: "roles/manager.md" },
        { role: "worker", provider: "", model: "", paseoTools: true, instructionsPath: "roles/worker.md" },
      ],
    });
  });
});

describe("plugin server entry — agents.list and roles.describe", () => {
  it("registers every handler: Phase 1 and the Dashboard", async () => {
    const handle = vi.fn();
    const registerSettings = vi.fn();
    contribute({ handle, registerSettings } as unknown as Parameters<typeof contribute>[0]);
    const contracts = handle.mock.calls.map(([contract]) => contract);
    // The settings screen reads `settings.paseo-bm.read`, an RPC the HOST only
    // contributes once the server declares the definition. Missing this call
    // left that screen unable to read or save (bm-settings-rpc-stgv).
    expect(registerSettings).toHaveBeenCalledTimes(1);
    expect(registerSettings.mock.calls[0]![0]).toMatchObject({ id: "paseo-bm", scope: "host", version: 1 });
    expect(contracts).toContain(agentsListRpc);
    expect(contracts).toContain(rolesDescribeRpc);
    expect(contracts.map((c: { name: string }) => c.name).sort()).toEqual([
      "agents.list",
      "agents.stop-all",
      "answers.mark",
      "answers.marks",
      "beads.action",
      "beads.get",
      "beads.list",
      "beads.lookup",
      "beads.stats",
      "chat.beads",
      "chat.peers",
      "chat.waiting",
      "fallback.act",
      "fallback.incidents",
      "manager.ensure",
      "roles.describe",
      "roles.instructions",
      "roles.options",
      "roles.save-extra",
      "roles.save-fallback",
      "roles.save-settings",
      "roles.settings",
      "setup.cleanup",
      "setup.ensure-roles",
      "setup.grant-agent-tools",
      "setup.install-skills",
      "setup.install-tool",
      "setup.status",
      "traces.delete",
      "traces.get",
      "traces.list",
      "traces.reassign",
      "traces.workspaces",
      "workspaces.overview",
    ]);

    const listHandler = handle.mock.calls.find(([c]) => c === agentsListRpc)![1];
    const { paseo } = fakeDirectory([agent({ id: "mgr", labels: { "bm.role": "manager" } })]);
    const output = await listHandler({ workspaceId: WS }, { paseo });
    expect(output.agents.map((a: { id: string }) => a.id)).toEqual(["mgr"]);
  });

  it("wires the handler's paseo into roles.describe (config in effect, no file read)", async () => {
    const handle = vi.fn();
    contribute({ handle, registerSettings: vi.fn() } as unknown as Parameters<typeof contribute>[0]);
    const describeHandler = handle.mock.calls.find(([c]) => c === rolesDescribeRpc)![1];
    const fake = fakeConfig(daemonConfig());
    const output = await describeHandler({}, { paseo: fake.paseo });
    expect(rolesDescribeRpc.output.parse(output).roles.map((r) => r.role)).toEqual(["manager", "worker", "reviewer"]);
    expect(fake.reads()).toBe(1);
  });
});
