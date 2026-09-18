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
import type { CliOutcome, PaseoCliDeps } from "../plugin/server/paseo-cli";
import type { ProviderMode } from "../plugin/server/role-mode";
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
  /**
   * What `providers.listModes` answers: a mode list, a rejection, or a promise
   * that never settles. Absent → the fake host has no `providers` at all.
   */
  modes?: ProviderMode[] | "reject" | "hang";
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
            Object.entries(filter.labels ?? {}).every(([k, v]) => a.labels[k] === v) &&
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
    ...(options.modes === undefined
      ? {}
      : {
          providers: {
            listModes(provider: string) {
              calls.push(`listModes:${provider}`);
              if (options.modes === "reject") return Promise.reject(new Error("provider warming up"));
              if (options.modes === "hang") return new Promise<never>(() => {});
              return Promise.resolve({ modes: options.modes });
            },
          },
        }),
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
  it("looks up the workspace's Managers first, then creates one from bm-manager with manager.md and both labels", async () => {
    const fake = fakePaseo({
      agents: [
        // Not a Manager, and a Manager of another workspace: neither counts.
        agent({ id: "worker-1", labels: { "bm.role": "worker" } }),
        agent({ id: "other-ws-manager", workspaceId: "ws-2" }),
      ],
    });

    const result = await ensureManager({ workspaceId: WS }, deps(fake.paseo));

    expect(result).toEqual({ agentId: "created-1", created: true, otherManagerIds: [], modeNotice: null });
    expect(fake.calls.indexOf("list")).toBeLessThan(fake.calls.indexOf("create"));
    // No label filter since delta 20260918g §4.2–§4.3: a Manager started from
    // Paseo's own new-agent flow carries no bm.role label and is recognised by
    // its bm-manager provider, which a label filter would hide from this lookup.
    expect(fake.listFilters[0]).toEqual({ includeArchived: false });

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

describe("manager.ensure — a new Manager's mode (delta 20260918 §4.1)", () => {
  // What `providers.listModes("bm-manager")` answered on the owner's daemon.
  const claudeModes: ProviderMode[] = [
    { id: "plan", colorTier: "planning" },
    { id: "default", colorTier: "safe" },
    { id: "acceptEdits", colorTier: "moderate" },
    { id: "auto", colorTier: "moderate" },
    { id: "bypassPermissions", colorTier: "dangerous" },
  ];
  // What the installer registers: a model, and no mode (ADR-006).
  const installedProfile: ManagerAgentProfile = { id: "bm-manager", provider: "bm-manager", model: "claude-opus-5" };

  async function create(options: FakeOptions) {
    const fake = fakePaseo({ profiles: [installedProfile], ...options });
    const logs: string[] = [];
    await ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), log: (message) => logs.push(message) });
    return { fake, logs, options: fake.createCalls[0]!.options };
  }

  it("starts in the provider's no-prompt mode and says so in bm.modeSet", async () => {
    const { fake, options, logs } = await create({ modes: claudeModes });

    expect(fake.calls).toContain("listModes:bm-manager");
    expect(options.config.modeId).toBe("bypassPermissions");
    expect(options.labels).toEqual({
      "bm.role": "manager",
      "bm.version": PLUGIN_VERSION,
      "bm.modeSet": "bypassPermissions",
    });
    expect(logs).toEqual([]);
  });

  it.each([
    ["an ordinary mode", "acceptEdits"],
    ["even a planning mode (Q31: the profile's own mode wins)", "plan"],
  ])("a mode set by hand on the profile wins — %s", async (_label, modeId) => {
    const { options } = await create({ profiles: [{ ...installedProfile, modeId }], modes: claudeModes });

    expect(options.config.modeId).toBe(modeId);
    expect(options.labels?.["bm.modeSet"]).toBe(modeId);
  });

  it("never picks a planning mode on its own, even when it is listed first", async () => {
    const { options } = await create({
      modes: [
        { id: "plan", colorTier: "planning" },
        { id: "bypassPermissions", colorTier: "dangerous" },
      ],
    });

    expect(options.config.modeId).toBe("bypassPermissions");
  });

  it("no mode that skips prompts: no mode and no label, rather than a guess — and says so once", async () => {
    const { options, logs } = await create({
      modes: [
        { id: "default", colorTier: "safe" },
        { id: "auto", colorTier: "moderate" },
      ],
    });

    expect(options.config).not.toHaveProperty("modeId");
    expect(options.labels).not.toHaveProperty("bm.modeSet");
    expect(logs).toEqual([
      "[paseo-bm] bm-manager lists no mode that runs without permission prompts; the Manager starts in the provider's default mode.",
    ]);
  });

  it("a profile mode the provider does not list is never passed on: creation would fail on it (review b3)", async () => {
    const { options, logs } = await create({
      profiles: [{ ...installedProfile, modeId: "custom-mode" }],
      modes: [
        { id: "default", colorTier: "safe" },
        { id: "auto", colorTier: "moderate" },
      ],
    });

    expect(options.config).not.toHaveProperty("modeId");
    expect(options.labels).not.toHaveProperty("bm.modeSet");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`nor the profile's own mode "custom-mode"`);
  });

  it("modes cannot be read: created exactly as before — the profile's mode, no label — and logged", async () => {
    const { options, logs } = await create({ profiles: [{ ...installedProfile, modeId: "acceptEdits" }], modes: "reject" });

    expect(options.config.modeId).toBe("acceptEdits");
    expect(options.labels).toEqual({ "bm.role": "manager", "bm.version": PLUGIN_VERSION });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/could not read the modes of bm-manager/);
  });

  it("a mode lookup that never answers costs 5 s and the mode, never the Manager", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakePaseo({ profiles: [installedProfile], modes: "hang" });
      const logs: string[] = [];
      const pending = ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), log: (message) => logs.push(message) });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;

      expect(result.created).toBe(true);
      expect(fake.createCalls[0]!.options.config).not.toHaveProperty("modeId");
      expect(fake.createCalls[0]!.options.labels).not.toHaveProperty("bm.modeSet");
      expect(logs[0]).toMatch(/took longer than 5000 ms/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("manager.ensure — Manager already exists", () => {
  it("returns it and creates nothing, even across list pages", async () => {
    const fillers = Array.from({ length: 5 }, (_, i) =>
      agent({ id: `elsewhere-${i}`, workspaceId: "ws-2" }),
    );
    const fake = fakePaseo({
      // Already switched by paseo-bm (bm.modeSet): opening it costs no lookup at all.
      agents: [...fillers, agent({ id: "mgr-existing", labels: { "bm.role": "manager", "bm.modeSet": "bypassPermissions" } })],
      pageSize: 2,
    });

    const first = await ensureManager({ workspaceId: WS }, deps(fake.paseo));
    const second = await ensureManager({ workspaceId: WS }, deps(fake.paseo));

    expect(first).toEqual({ agentId: "mgr-existing", created: false, otherManagerIds: [], modeNotice: null });
    expect(second).toEqual(first);
    expect(fake.createCalls).toHaveLength(0);
    expect(fake.calls).not.toContain("config.get");
  });
});

describe("manager.ensure — an existing Manager is switched once (delta 20260918 §4.1)", () => {
  const claudeModes: ProviderMode[] = [
    { id: "plan", colorTier: "planning" },
    { id: "default", colorTier: "safe" },
    { id: "bypassPermissions", colorTier: "dangerous" },
  ];
  const installedProfile: ManagerAgentProfile = { id: "bm-manager", provider: "bm-manager", model: "claude-opus-5" };

  /** A fake `paseo` CLI. No test here may start the real binary or reach a daemon. */
  function fakeCli(answers: Partial<Record<"mode" | "update", CliOutcome>> = {}, found: string | null = "/opt/fake/paseo") {
    const runs: string[][] = [];
    const cli: PaseoCliDeps = {
      find: () => found,
      run: async (file, args) => {
        runs.push([file, ...args]);
        return answers[args[1] as "mode" | "update"] ?? { code: 0, output: "{}", timedOut: false };
      },
    };
    return { cli, runs };
  }

  async function open(manager: Partial<ManagerAgentSnapshot>, cliFake = fakeCli(), extra: FakeOptions = {}) {
    const fake = fakePaseo({
      agents: [agent({ id: "mgr-1", currentModeId: "default", ...manager })],
      profiles: [installedProfile],
      modes: claudeModes,
      ...extra,
    });
    const result = await ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), cli: cliFake.cli, log: () => {} });
    return { fake, result, runs: cliFake.runs };
  }

  it("already marked with bm.modeSet: never touched again, so a mode picked by hand stays", async () => {
    const { result, runs, fake } = await open({
      currentModeId: "default",
      labels: { "bm.role": "manager", "bm.modeSet": "bypassPermissions" },
    });

    expect(runs).toEqual([]);
    expect(fake.calls).not.toContain("config.get");
    expect(result.modeNotice).toBeNull();
  });

  it("idle, not marked, in default: switches the mode, then marks it — exactly these two commands", async () => {
    const { result, runs, fake } = await open({});

    expect(runs).toEqual([
      ["/opt/fake/paseo", "agent", "mode", "mgr-1", "bypassPermissions", "--json"],
      ["/opt/fake/paseo", "agent", "update", "mgr-1", "--label", "bm.modeSet=bypassPermissions", "--json"],
    ]);
    expect(result).toEqual({ agentId: "mgr-1", created: false, otherManagerIds: [], modeNotice: null });
    expect(fake.createCalls).toEqual([]);
  });

  it("already in the target mode: only marks it", async () => {
    const { runs } = await open({ currentModeId: "bypassPermissions" });

    expect(runs.map((run) => run[2])).toEqual(["update"]);
  });

  it("the profile's own mode wins here too, even a planning one (Q31)", async () => {
    const { runs } = await open({}, fakeCli(), { profiles: [{ ...installedProfile, modeId: "plan" }] });

    expect(runs[0]).toEqual(["/opt/fake/paseo", "agent", "mode", "mgr-1", "plan", "--json"]);
    expect(runs[1]).toContain("bm.modeSet=plan");
  });

  it("running: no command at all, and the user is told it happens on the next open (Q37)", async () => {
    const { result, runs } = await open({ status: "running" });

    expect(runs).toEqual([]);
    expect(result.modeNotice).toMatch(/busy.*next time you open it/);
  });

  it("modes cannot be read: nothing to switch to, nothing run, nothing to say", async () => {
    const { result, runs } = await open({}, fakeCli(), { modes: "reject" });

    expect(runs).toEqual([]);
    expect(result.modeNotice).toBeNull();
  });

  it.each([
    ["paseo not found", fakeCli({}, null), /`paseo` command was not found/],
    ["paseo exits non-zero", fakeCli({ mode: { code: 1, output: "Error: agent is closed\nmore", timedOut: false } }), /exited with 1: Error: agent is closed/],
    ["paseo takes too long", fakeCli({ mode: { code: 1, output: "", timedOut: true } }), /took longer than 5000 ms/],
  ])("%s: the Manager is still returned, with a notice saying how to switch by hand", async (_label, cliFake, reason) => {
    const { result, runs } = await open({}, cliFake);

    expect(result.agentId).toBe("mgr-1");
    expect(result.modeNotice).toMatch(reason);
    expect(result.modeNotice).toMatch(/Switch its mode yourself in Paseo/);
    // The mark is only written after a successful switch.
    expect(runs.filter((run) => run[2] === "update")).toEqual([]);
  });

  it("switched but not marked: says so; the next open marks it without switching again", async () => {
    const { result } = await open({}, fakeCli({ update: { code: 1, output: "label rejected", timedOut: false } }));

    expect(result.modeNotice).toMatch(/is in "bypassPermissions", but could not be marked/);
  });

  it("an id that would read as a flag never reaches the command line", async () => {
    const { result, runs } = await open({ id: "--help" });

    expect(runs).toEqual([]);
    expect(result.modeNotice).toMatch(/refusing an unexpected agent id/);
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

    expect(result).toEqual({ agentId: "mgr-new", created: false, otherManagerIds: ["mgr-old"], modeNotice: null });
    expect(fake.createCalls).toHaveLength(0);
    expect(fake.archived).toEqual([]);
    expect(fake.liveManagers().map((a) => a.id).sort()).toEqual(["mgr-new", "mgr-old"]);
  });
});

describe("manager.ensure — a Manager without the bm.role label (delta 20260918g §4.3)", () => {
  /** A Manager started from Paseo's own new-agent flow with the Manager profile: no labels at all. */
  const unlabelled = (overrides: Partial<ManagerAgentSnapshot> & { id: string }) =>
    agent({ provider: "bm-manager/claude-opus-5", labels: {}, currentModeId: "default", ...overrides });

  it("opens it instead of creating a second Manager, and never switches its mode", async () => {
    const runs: string[][] = [];
    const cli: PaseoCliDeps = {
      find: () => "/opt/fake/paseo",
      run: async (file, args) => {
        runs.push([file, ...args]);
        return { code: 0, output: "{}", timedOut: false };
      },
    };
    const fake = fakePaseo({
      agents: [unlabelled({ id: "user-mgr" })],
      profiles: [{ id: "bm-manager", provider: "bm-manager", model: "claude-opus-5" }],
      modes: [
        { id: "default", colorTier: "safe" },
        { id: "bypassPermissions", colorTier: "dangerous" },
      ],
    });

    const result = await ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), cli, log: () => {} });

    expect(result).toEqual({ agentId: "user-mgr", created: false, otherManagerIds: [], modeNotice: null });
    expect(fake.createCalls).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("prefers a labelled Manager over a newer unlabelled one, and reports the unlabelled one", async () => {
    const fake = fakePaseo({
      agents: [
        agent({ id: "bm-mgr", createdAt: "2026-09-15T08:00:00.000Z" }),
        unlabelled({ id: "user-mgr", createdAt: "2026-09-15T10:00:00.000Z" }),
      ],
    });

    const result = await ensureManager({ workspaceId: WS }, deps(fake.paseo));

    expect(result).toEqual({ agentId: "bm-mgr", created: false, otherManagerIds: ["user-mgr"], modeNotice: null });
    expect(fake.createCalls).toEqual([]);
  });

  it("does not take another provider's unlabelled agent for a Manager", async () => {
    const fake = fakePaseo({ agents: [agent({ id: "plain-claude", provider: "claude", labels: {} })] });

    const result = await ensureManager({ workspaceId: WS }, deps(fake.paseo));

    expect(result.created).toBe(true);
    expect(fake.createCalls).toHaveLength(1);
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
    const cleanup = contribute({ handle, registerSettings: vi.fn() } as unknown as Parameters<typeof contribute>[0]);
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
      modeNotice: null,
    });
  });

  it("reads roles/manager.md from the payload", async () => {
    expect(await readManagerInstructions()).toBe(managerMd);
  });
});
