import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ensureManager,
  ManagerEnsureError,
  type ManagerAgentHandle,
  type ManagerAgentProfile,
  type ManagerAgentSnapshot,
  type ManagerPaseo,
} from "../plugin/server/manager";
import contribute, { readManagerInstructions } from "../plugin/index.server";
import { managerEnsureRpc } from "../plugin/shared/contracts";
import { PLUGIN_VERSION } from "../plugin/shared/version";

// The entry resolves the install home from $HOME when Paseo's config names no
// plugin path; point it at an empty directory so this machine's real
// ~/.paseo-bm (and any role-extras.json in it) never leaks into the test.
const realHome = process.env.HOME;
const isolatedHome = mkdtempSync(join(tmpdir(), "bm-isolated-home-"));
beforeAll(() => {
  process.env.HOME = isolatedHome;
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(isolatedHome, { recursive: true, force: true });
});

/**
 * WP-112 `manager.ensure` against a fake Paseo SDK. No daemon is contacted and
 * no real agent is created.
 */

const managerMd = readFileSync(
  fileURLToPath(new URL("../plugin/roles/manager.md", import.meta.url)),
  "utf8",
);

const WS = "ws-1";

const bmManagerProfile: ManagerAgentProfile = {
  id: "bm-manager",
  provider: "bm-manager",
  model: "gpt-5.6-sol",
  modeId: "full-access",
  thinkingOptionId: "high",
};

type CreateOptions = Parameters<
  ReturnType<ManagerPaseo["workspaces"]["ref"]>["agents"]["create"]
>[0];

interface FakeOptions {
  agents?: ManagerAgentSnapshot[];
  profiles?: ManagerAgentProfile[];
  /** Makes `create` reject with this error, creating nothing. */
  createRejects?: Error;
  /** Makes `create` resolve with an agent already in this state. */
  createdSnapshot?: Partial<ManagerAgentSnapshot>;
  pageSize?: number;
}

function agent(overrides: Partial<ManagerAgentSnapshot> & { id: string }): ManagerAgentSnapshot {
  return {
    workspaceId: WS,
    createdAt: "2026-09-15T08:00:00.000Z",
    status: "idle",
    labels: { "bm.role": "manager", "bm.version": "0.1.0-alpha.0" },
    archivedAt: null,
    ...overrides,
  };
}

function fakePaseo(options: FakeOptions = {}) {
  const store: ManagerAgentSnapshot[] = [...(options.agents ?? [])];
  const calls: string[] = [];
  const createCalls: Array<{ workspaceId: string; options: CreateOptions }> = [];
  const archived: string[] = [];
  const listFilters: unknown[] = [];
  const pageSize = options.pageSize ?? 200;
  let seq = 0;

  const paseo: ManagerPaseo = {
    agents: {
      async list({ filter, page }) {
        calls.push("list");
        listFilters.push(filter);
        const matching = store.filter(
          (a) =>
            Object.entries(filter.labels).every(([k, v]) => a.labels[k] === v) &&
            (filter.includeArchived || !a.archivedAt),
        );
        const start = page.cursor ? Number(page.cursor) : 0;
        const slice = matching.slice(start, start + Math.min(pageSize, page.limit));
        const next = start + slice.length;
        const hasMore = next < matching.length;
        return {
          entries: slice.map((a) => ({ agent: { ...a } })),
          pageInfo: { hasMore, nextCursor: hasMore ? String(next) : null },
        };
      },
    },
    workspaces: {
      ref(workspaceId) {
        return {
          agents: {
            async create(createOptions) {
              calls.push("create");
              createCalls.push({ workspaceId, options: createOptions });
              if (options.createRejects) throw options.createRejects;
              seq += 1;
              const snapshot = agent({
                id: `created-${seq}`,
                workspaceId,
                createdAt: "2026-09-15T12:00:00.000Z",
                labels: { ...(createOptions.labels ?? {}) },
                status: "initializing",
                ...options.createdSnapshot,
              });
              store.push(snapshot);
              const handle: ManagerAgentHandle = {
                id: snapshot.id,
                current: () => ({ ...snapshot }),
                async archive() {
                  archived.push(snapshot.id);
                  snapshot.archivedAt = "2026-09-15T12:00:01.000Z";
                  return { archivedAt: snapshot.archivedAt };
                },
              };
              return handle;
            },
          },
        };
      },
    },
    config: {
      async get() {
        calls.push("config.get");
        return { config: { agentProfiles: options.profiles ?? [bmManagerProfile] } };
      },
    },
  };

  const liveManagers = () =>
    store.filter((a) => a.labels["bm.role"] === "manager" && !a.archivedAt && a.status !== "closed");

  return { paseo, store, calls, createCalls, archived, listFilters, liveManagers };
}

const deps = (paseo: ManagerPaseo) => ({
  paseo,
  readInstructions: readManagerInstructions,
});

describe("manager.ensure — no Manager yet", () => {
  it("looks up by label first, then creates one from bm-manager with manager.md and both labels", async () => {
    const fake = fakePaseo({
      agents: [
        // Not a Manager, and a Manager of another workspace: neither counts.
        agent({ id: "worker-1", labels: { "bm.role": "worker" } }),
        agent({ id: "other-ws-manager", workspaceId: "ws-2" }),
      ],
    });

    const result = await ensureManager({ workspaceId: WS }, deps(fake.paseo));

    expect(result).toEqual({ agentId: "created-1", created: true, otherManagerIds: [] });
    expect(fake.calls.indexOf("list")).toBeLessThan(fake.calls.indexOf("create"));
    expect(fake.listFilters[0]).toEqual({
      labels: { "bm.role": "manager" },
      includeArchived: false,
    });

    expect(fake.createCalls).toHaveLength(1);
    const { workspaceId, options } = fake.createCalls[0]!;
    expect(workspaceId).toBe(WS);
    expect(options.config).toEqual({
      provider: "bm-manager/gpt-5.6-sol",
      modeId: "full-access",
      thinkingOptionId: "high",
      systemPrompt: managerMd,
    });
    expect(options.labels).toEqual({ "bm.role": "manager", "bm.version": PLUGIN_VERSION });
    expect(fake.archived).toEqual([]);
  });

  it("creates a new one when the only Managers are archived or closed", async () => {
    const fake = fakePaseo({
      agents: [
        agent({ id: "archived", archivedAt: "2026-09-14T00:00:00.000Z" }),
        agent({ id: "closed", status: "closed" }),
      ],
    });

    const result = await ensureManager({ workspaceId: WS }, deps(fake.paseo));

    expect(result.created).toBe(true);
    expect(fake.createCalls).toHaveLength(1);
  });
});

describe("manager.ensure — Manager already exists", () => {
  it("returns it and creates nothing, even across list pages", async () => {
    const fillers = Array.from({ length: 5 }, (_, i) =>
      agent({ id: `elsewhere-${i}`, workspaceId: "ws-2" }),
    );
    const fake = fakePaseo({
      agents: [...fillers, agent({ id: "mgr-existing" })],
      pageSize: 2,
    });

    const first = await ensureManager({ workspaceId: WS }, deps(fake.paseo));
    const second = await ensureManager({ workspaceId: WS }, deps(fake.paseo));

    expect(first).toEqual({ agentId: "mgr-existing", created: false, otherManagerIds: [] });
    expect(second).toEqual(first);
    expect(fake.createCalls).toHaveLength(0);
    expect(fake.calls).not.toContain("config.get");
  });
});

describe("manager.ensure — two live Managers", () => {
  it("picks the newest, reports the other, and deletes or archives nothing", async () => {
    const fake = fakePaseo({
      agents: [
        agent({ id: "mgr-old", createdAt: "2026-09-15T08:00:00.000Z" }),
        agent({ id: "mgr-new", createdAt: "2026-09-15T10:00:00.000Z", status: "running" }),
      ],
    });

    const result = await ensureManager({ workspaceId: WS }, deps(fake.paseo));

    expect(result).toEqual({ agentId: "mgr-new", created: false, otherManagerIds: ["mgr-old"] });
    expect(fake.createCalls).toHaveLength(0);
    expect(fake.archived).toEqual([]);
    expect(fake.liveManagers().map((a) => a.id).sort()).toEqual(["mgr-new", "mgr-old"]);
  });
});

describe("manager.ensure — creation fails", () => {
  it("provider not ready (create rejects): coded error, no agent left behind", async () => {
    const fake = fakePaseo({
      createRejects: new Error("provider bm-manager is not available"),
    });

    const error = await ensureManager({ workspaceId: WS }, deps(fake.paseo)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ManagerEnsureError);
    expect((error as ManagerEnsureError).code).toBe("E_PROVIDER_UNAVAILABLE");
    expect((error as Error).message).toMatch(/^E_PROVIDER_UNAVAILABLE: /);
    expect(fake.store).toEqual([]);
    expect(fake.archived).toEqual([]);
  });

  it.each([
    ["status error (e.g. not logged in, quota)", { status: "error", lastError: "not logged in" }],
    ["providerUnavailable", { status: "initializing", providerUnavailable: true }],
  ])(
    "agent created but already failed (%s): coded error, archives exactly that agent",
    async (_label, createdSnapshot) => {
      const fake = fakePaseo({
        agents: [agent({ id: "worker-1", labels: { "bm.role": "worker" } })],
        createdSnapshot,
      });

      const error = await ensureManager({ workspaceId: WS }, deps(fake.paseo)).catch(
        (e: unknown) => e,
      );

      expect((error as ManagerEnsureError).code).toBe("E_PROVIDER_UNAVAILABLE");
      expect(fake.archived).toEqual(["created-1"]);
      expect(fake.liveManagers()).toEqual([]);
      expect(fake.store.find((a) => a.id === "worker-1")?.archivedAt).toBeNull();
    },
  );

  it("bm-manager profile missing: coded error, nothing created", async () => {
    const fake = fakePaseo({ profiles: [{ id: "room-worker", provider: "codex" }] });

    const error = await ensureManager({ workspaceId: WS }, deps(fake.paseo)).catch((e: unknown) => e);

    expect((error as ManagerEnsureError).code).toBe("E_PROVIDER_UNAVAILABLE");
    expect(fake.createCalls).toHaveLength(0);
  });
});

describe("plugin server entry", () => {
  it("registers manager.ensure and wires the handler's paseo into ensureManager", async () => {
    const handle = vi.fn();
    const cleanup = contribute({ handle } as unknown as Parameters<typeof contribute>[0]);
    expect(typeof cleanup).toBe("function");

    const registration = handle.mock.calls.find(([contract]) => contract === managerEnsureRpc);
    expect(registration).toBeDefined();

    const fake = fakePaseo({
      agents: [
        agent({ id: "mgr-old", createdAt: "2026-09-15T08:00:00.000Z" }),
        agent({ id: "mgr-new", createdAt: "2026-09-15T09:00:00.000Z" }),
      ],
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const output = await registration![1]({ workspaceId: WS }, { paseo: fake.paseo });
    warn.mockRestore();

    expect(managerEnsureRpc.output.parse(output)).toEqual({
      agentId: "mgr-new",
      created: false,
      otherManagerIds: ["mgr-old"],
    });
  });

  it("reads roles/manager.md from the payload", async () => {
    expect(await readManagerInstructions()).toBe(managerMd);
  });
});
