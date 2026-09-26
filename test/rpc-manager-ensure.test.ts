import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createManager,
  ensureManager,
  AGENT_TOOLS_OFF_MESSAGE,
  ManagerEnsureError,
  type ManagerAgentHandle,
  type ManagerAgentProfile,
  type ManagerAgentSnapshot,
  type ManagerPaseo,
} from "../plugin/server/manager";
import type { CliOutcome, PaseoCliDeps } from "../plugin/server/paseo-cli";
import type { ProviderMode } from "../plugin/server/role-mode";
import { markCleanedUpThisRun } from "../plugin/server/setup-roles";
import contribute, { readManagerInstructions } from "../plugin/index.server";
import { managerEnsureRpc, type FallbackIncident } from "../plugin/shared/contracts";
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
  /**
   * The `agents.providers` map. Defaults to a machine that is already set up,
   * so `ensureRoles` (0.4.0) finds nothing missing and patches nothing.
   */
  providers?: Record<string, unknown>;
  /** `daemon.mcp.injectIntoAgents`, absent unless a test cares. */
  injectIntoAgents?: boolean;
  /** What `providers.listAvailable` answers; absent → the host cannot say. */
  available?: Array<{ provider: string; available: boolean }>;
  /** What `providers.listModels` answers per provider. */
  models?: Record<string, Array<{ id: string }>>;
}

/** The three aliases of a machine that has been set up (0.4.0, design §6.1). */
const roleAliases = (): Record<string, unknown> => ({
  "bm-manager": { extends: "codex", label: "Beads Manager" },
  "bm-worker": { extends: "codex", label: "Beads Worker" },
  "bm-reviewer": { extends: "codex", label: "Beads Reviewer" },
});

/** The two profiles besides the Manager's; every test's config carries them. */
const otherRoleProfiles = (): ManagerAgentProfile[] => [
  { id: "bm-worker", provider: "bm-worker", model: "gpt-5.6-sol" },
  { id: "bm-reviewer", provider: "bm-reviewer", model: "gpt-5.6-sol" },
];

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
  const patches: Array<Record<string, unknown>> = [];
  const createCalls: Array<{ workspaceId: string; options: CreateOptions }> = [];
  const configState: { providers: Record<string, unknown>; agentProfiles: ManagerAgentProfile[]; mcp?: { injectIntoAgents: boolean } } = {
    providers: options.providers ?? roleAliases(),
    agentProfiles: [...(options.profiles ?? [bmManagerProfile]), ...otherRoleProfiles()],
    ...(options.injectIntoAgents === undefined ? {} : { mcp: { injectIntoAgents: options.injectIntoAgents } }),
  };
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
        return { config: structuredClone(configState) };
      },
      async patch(patch: Record<string, unknown>) {
        calls.push("config.patch");
        patches.push(structuredClone(patch));
        for (const [id, entry] of Object.entries((patch["providers"] ?? {}) as Record<string, Record<string, unknown>>)) {
          configState.providers[id] = { ...((configState.providers[id] ?? {}) as object), ...entry };
        }
        if (patch["agentProfiles"] !== undefined) configState.agentProfiles = structuredClone(patch["agentProfiles"]) as ManagerAgentProfile[];
        return {};
      },
    },
    ...(options.modes === undefined && options.available === undefined && options.models === undefined
      ? {}
      : {
          providers: {
            ...(options.modes === undefined
              ? {}
              : {
                  listModes(provider: string) {
                    calls.push(`listModes:${provider}`);
                    if (options.modes === "reject") return Promise.reject(new Error("provider warming up"));
                    if (options.modes === "hang") return new Promise<never>(() => {});
                    return Promise.resolve({ modes: options.modes });
                  },
                }),
            ...(options.available === undefined ? {} : { listAvailable: async () => ({ providers: options.available }) }),
            ...(options.models === undefined
              ? {}
              : { listModels: async (provider: string) => ({ provider, models: options.models?.[provider] ?? [] }) }),
          },
        }),
  };

  const liveManagers = () =>
    store.filter((a) => a.labels["bm.role"] === "manager" && !a.archivedAt && a.status !== "closed");

  return { paseo, store, calls, patches, createCalls, archived, listFilters, liveManagers, config: () => configState };
}

const deps = (paseo: ManagerPaseo) => ({
  paseo,
  readInstructions: readManagerInstructions,
  // No install home, so no fallback incident: without this the replaced-Manager
  // lookup would read the home through `config.get` (delta 20260921 §4.5.2).
  home: null,
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

    expect(result).toEqual({ agentId: "created-1", created: true, otherManagerIds: [], modeNotice: null, toolsNotice: null, setupNotice: null });
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

    expect(first).toEqual({ agentId: "mgr-existing", created: false, otherManagerIds: [], modeNotice: null, toolsNotice: null, setupNotice: null });
    expect(second).toEqual(first);
    expect(fake.createCalls).toHaveLength(0);
    // The profile is never read for an existing Manager. From 0.4.0 the config
    // is still read — `ensureRoles` and the setup notice both look at it — but
    // nothing is written when the machine is already set up.
    expect(fake.patches).toEqual([]);
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
    // Reading the config is fine (0.4.0 checks the roles and the tools switch);
    // writing it, or reading the Manager's profile, is what must not happen.
    expect(fake.patches).toEqual([]);
    expect(result.modeNotice).toBeNull();
  });

  it("idle, not marked, in default: switches the mode, then marks it — exactly these two commands", async () => {
    const { result, runs, fake } = await open({});

    expect(runs).toEqual([
      ["/opt/fake/paseo", "agent", "mode", "mgr-1", "bypassPermissions", "--json"],
      ["/opt/fake/paseo", "agent", "update", "mgr-1", "--label", "bm.modeSet=bypassPermissions", "--json"],
    ]);
    expect(result).toEqual({ agentId: "mgr-1", created: false, otherManagerIds: [], modeNotice: null, toolsNotice: null, setupNotice: null });
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

    expect(result).toEqual({ agentId: "mgr-new", created: false, otherManagerIds: ["mgr-old"], modeNotice: null, toolsNotice: null, setupNotice: null });
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

    expect(result).toEqual({ agentId: "user-mgr", created: false, otherManagerIds: [], modeNotice: null, toolsNotice: null, setupNotice: null });
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

    expect(result).toEqual({ agentId: "bm-mgr", created: false, otherManagerIds: ["user-mgr"], modeNotice: null, toolsNotice: null, setupNotice: null });
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

  it("bm-manager profile missing and nothing to create it with: coded error, nothing created", async () => {
    const fake = fakePaseo({ profiles: [{ id: "room-worker", provider: "codex" }] });

    const error = await ensureManager({ workspaceId: WS }, deps(fake.paseo)).catch((e: unknown) => e);

    expect((error as ManagerEnsureError).code).toBe("E_PROVIDER_UNAVAILABLE");
    expect(fake.createCalls).toHaveLength(0);
  });
});

describe("manager.ensure sets the machine up (0.4.0, ADR-012 decision 4)", () => {
  /** A daemon with nothing of paseo-bm in it, and a provider to create the roles on. */
  const fresh = (extra: Parameters<typeof fakePaseo>[0] = {}) =>
    fakePaseo({
      providers: {},
      profiles: [],
      available: [{ provider: "codex", available: true }],
      models: { codex: [{ id: "gpt-5.6-sol" }] },
      ...extra,
    });

  it("creates the three roles on the way in, then the Manager, and says so", async () => {
    const fake = fresh();

    const result = await ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), log: () => {} });

    expect(fake.patches).toHaveLength(1);
    expect(Object.keys(fake.config().providers)).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
    expect(result.created).toBe(true);
    expect(result.setupNotice).toBe(
      "paseo-bm created its roles with defaults (codex · gpt-5.6-sol). Change them in Setup → Agents.",
    );
  });

  it("says nothing when the machine is already set up and Paseo's agent tools are on", async () => {
    const fake = fakePaseo({ injectIntoAgents: true });

    const result = await ensureManager({ workspaceId: WS }, deps(fake.paseo));

    expect(result.setupNotice).toBeNull();
    expect(fake.patches).toEqual([]);
  });

  it("warns about Paseo's agent-tools switch on every call that opens a Manager", async () => {
    const fake = fakePaseo({ agents: [agent({ id: "mgr-1" })], injectIntoAgents: false });

    const first = await ensureManager({ workspaceId: WS }, deps(fake.paseo));
    const second = await ensureManager({ workspaceId: WS }, deps(fake.paseo));

    expect(first.setupNotice).toBe(
      "Paseo's agent tools are off, so the Manager may not be able to create a Worker. Allow them in Setup.",
    );
    expect(second.setupNotice).toBe(first.setupNotice);
  });

  it("puts the roles sentence before the agent-tools one when both are true", async () => {
    const fake = fresh({ agents: [agent({ id: "mgr-1" })], injectIntoAgents: false });

    const result = await ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), log: () => {} });

    expect(result.setupNotice).toBe(
      "paseo-bm created its roles with defaults (codex · gpt-5.6-sol). Change them in Setup → Agents. " +
        "Paseo's agent tools are off, so the Manager may not be able to create a Worker. Allow them in Setup.",
    );
  });

  it("creates no Manager while Paseo's agent tools are off, but still creates the roles", async () => {
    // A Manager gets Paseo's tools only when it is created: one made now would
    // stay without create_agent after the user allows them (clean-install run
    // 2026-09-26), and only the user may archive it.
    const fake = fresh({ injectIntoAgents: false });

    const error = await ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), log: () => {} }).catch((e: unknown) => e);

    expect((error as ManagerEnsureError).code).toBe("E_PROVIDER_UNAVAILABLE");
    expect((error as Error).message).toBe(`E_PROVIDER_UNAVAILABLE: ${AGENT_TOOLS_OFF_MESSAGE}`);
    expect(fake.createCalls).toHaveLength(0);
    expect(Object.keys(fake.config().providers)).toEqual(["bm-manager", "bm-worker", "bm-reviewer"]);
  });

  it("creates the Manager once the switch is on", async () => {
    const fake = fresh({ injectIntoAgents: true });

    const result = await ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), log: () => {} });

    expect(result.created).toBe(true);
    expect(fake.createCalls).toHaveLength(1);
  });

  it("creates no Manager when the roles cannot be created, and points at Setup", async () => {
    const fake = fakePaseo({ providers: {}, profiles: [], available: [{ provider: "codex", available: false }] });

    const error = await ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), log: () => {} }).catch((e: unknown) => e);

    expect((error as ManagerEnsureError).code).toBe("E_PROVIDER_UNAVAILABLE");
    expect((error as Error).message).toBe(
      "E_PROVIDER_UNAVAILABLE: paseo-bm could not create its roles (E_SETUP_ROLES_FAILED: Paseo reports no available provider). Open Beads Manager → Setup to see what is missing.",
    );
    expect(fake.createCalls).toHaveLength(0);
  });

  it("refuses to recreate what the user removed, and says how to resume or finish removing", async () => {
    const fake = fresh();
    markCleanedUpThisRun(true);
    try {
      const error = await ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), log: () => {} }).catch((e: unknown) => e);

      expect((error as ManagerEnsureError).code).toBe("E_PROVIDER_UNAVAILABLE");
      expect((error as Error).message).toBe(
        'E_PROVIDER_UNAVAILABLE: paseo-bm\'s settings were removed. Open Beads Manager → Setup and choose "Set up again", or remove the plugin with: paseo plugin remove paseo-bm',
      );
      expect(fake.patches).toEqual([]);
      expect(fake.createCalls).toHaveLength(0);
    } finally {
      markCleanedUpThisRun(false);
    }
  });

  it("parses an older server's answer that has no setupNotice", () => {
    expect(
      managerEnsureRpc.output.parse({ agentId: "mgr-1", created: false, otherManagerIds: [], modeNotice: null, toolsNotice: null }),
    ).not.toHaveProperty("setupNotice");
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
      toolsNotice: null,
      setupNotice: null,
    });
  });

  it("reads roles/manager.md from the payload", async () => {
    expect(await readManagerInstructions()).toBe(managerMd);
  });
});

describe("manager.ensure — posture by provider capability (delta 20260921 §4.2.2, REQ-063)", () => {
  const openCodeModes: ProviderMode[] = [{ id: "bytes" }, { id: "review" }];
  const openCodeFeatures = [{ type: "toggle", id: "auto_accept", label: "Auto Accept", value: false }];
  const openCodeProfile: ManagerAgentProfile = { id: "bm-manager", provider: "bm-manager", model: "anthropic/claude-sonnet-4-6" };

  function withFeatures(fake: ReturnType<typeof fakePaseo>, features: unknown[] = openCodeFeatures) {
    const listFeatures = vi.fn(async () => ({ features }));
    (fake.paseo as unknown as { providers: Record<string, unknown> }).providers.listFeatures = listFeatures;
    return listFeatures;
  }

  it("creates a Manager on OpenCode in a listed mode with auto-approve on, reading the features in the workspace's directory", async () => {
    const fake = fakePaseo({ profiles: [openCodeProfile], modes: openCodeModes });
    const listFeatures = withFeatures(fake);
    const logs: string[] = [];
    await ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), workspaceDirectory: async () => "/repo", log: (m) => logs.push(m) });
    const options = fake.createCalls[0]!.options;
    expect(options.config.modeId).toBe("bytes");
    expect(options.config.featureValues).toEqual({ auto_accept: true });
    expect(options.labels?.["bm.modeSet"]).toBe("bytes");
    expect(listFeatures).toHaveBeenCalledWith({ provider: "bm-manager/anthropic/claude-sonnet-4-6", cwd: "/repo" });
    expect(logs).toEqual([]);
  });

  it("keeps the profile's own OpenCode agent and its own auto_accept", async () => {
    const fake = fakePaseo({ profiles: [{ ...openCodeProfile, modeId: "review", featureValues: { auto_accept: false } }], modes: openCodeModes });
    withFeatures(fake);
    await ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), workspaceDirectory: async () => "/repo", log: () => {} });
    const options = fake.createCalls[0]!.options;
    expect(options.config.modeId).toBe("review");
    expect(options.config.featureValues).toEqual({ auto_accept: false });
  });

  it("creates a Manager on Pi (no modes) with no mode, no feature and no label, and says nothing", async () => {
    const fake = fakePaseo({ profiles: [{ id: "bm-manager", provider: "bm-manager", model: "qwen" }], modes: [] });
    const listFeatures = withFeatures(fake, []);
    const logs: string[] = [];
    await ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), log: (m) => logs.push(m) });
    const options = fake.createCalls[0]!.options;
    expect(options.config).not.toHaveProperty("modeId");
    expect(options.config).not.toHaveProperty("featureValues");
    expect(options.labels).not.toHaveProperty("bm.modeSet");
    expect(listFeatures).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("does not switch an existing labelled Manager on OpenCode, and says why, unless it already auto-approves", async () => {
    const make = (features?: Array<{ id: string; value: unknown }>) =>
      fakePaseo({
        agents: [agent({ id: "mgr-1", currentModeId: "bytes", ...(features ? { features } : {}) })],
        profiles: [openCodeProfile],
        modes: openCodeModes,
      });
    const cli = { find: () => "/opt/fake/paseo", run: vi.fn(async () => ({ code: 0, output: "{}", timedOut: false })) };
    const without = await ensureManager({ workspaceId: WS }, { ...deps(make().paseo), cli, log: () => {} });
    expect(without.created).toBe(false);
    expect(without.modeNotice).toMatch(/created before paseo-bm could turn on auto-approve/);
    const withIt = await ensureManager({ workspaceId: WS }, { ...deps(make([{ id: "auto_accept", value: true }]).paseo), cli, log: () => {} });
    expect(withIt.modeNotice).toBeNull();
    expect(cli.run).not.toHaveBeenCalled();
  });
});

describe("manager.ensure — a new Manager without Paseo tools (delta 20260921 §4.2.4, REQ-063 d)", () => {
  it("returns toolsNotice when the created Manager reports supportsMcpServers false, and records it for the Setup screen", async () => {
    const { toolsSeen, forgetTools } = await import("../plugin/server/tools-check");
    forgetTools();
    const fake = fakePaseo({ profiles: [{ id: "bm-manager", provider: "bm-manager", model: "qwen" }], modes: [], createdSnapshot: { capabilities: { supportsMcpServers: false } } });
    const result = await ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), log: () => {} });
    expect(result.toolsNotice).toBe(
      "This Manager runs on bm-manager/qwen without Paseo tools (on Pi this means pi-mcp-adapter is missing): it cannot create or message a Worker.",
    );
    expect(toolsSeen().manager).toMatchObject({ state: "missing", agentId: result.agentId, provider: "bm-manager/qwen" });
  });

  it("says nothing when the Manager has its tools, when Paseo does not say, or when the Manager already existed", async () => {
    const withTools = fakePaseo({ createdSnapshot: { capabilities: { supportsMcpServers: true } } });
    expect((await ensureManager({ workspaceId: WS }, { ...deps(withTools.paseo), log: () => {} })).toolsNotice).toBeNull();
    const silent = fakePaseo({});
    expect((await ensureManager({ workspaceId: WS }, { ...deps(silent.paseo), log: () => {} })).toolsNotice).toBeNull();
    const existing = fakePaseo({ agents: [agent({ id: "mgr-1", labels: { "bm.role": "manager", "bm.modeSet": "x" } })] });
    expect((await ensureManager({ workspaceId: WS }, { ...deps(existing.paseo), log: () => {} })).toolsNotice).toBeNull();
  });

  it("an older server's answer without toolsNotice still parses", () => {
    expect(managerEnsureRpc.output.parse({ agentId: "mgr-1", created: false, otherManagerIds: [], modeNotice: null })).not.toHaveProperty("toolsNotice");
  });
});

describe("manager.ensure — review b4: a Manager on Pi gets no feature from its profile", () => {
  it("drops the profile's featureValues and modeId on a provider without modes", async () => {
    const fake = fakePaseo({ profiles: [{ id: "bm-manager", provider: "bm-manager", model: "qwen", modeId: "x", featureValues: { fast_mode: true } }], modes: [] });
    await ensureManager({ workspaceId: WS }, { ...deps(fake.paseo), log: () => {} });
    const options = fake.createCalls[0]!.options;
    expect(options.config).not.toHaveProperty("modeId");
    expect(options.config).not.toHaveProperty("featureValues");
  });
});

describe("manager.ensure — a replaced Manager is skipped (delta 20260921 §4.5.2, REQ-066 c)", () => {
  const marked = { "bm.role": "manager", "bm.modeSet": "bypassPermissions" };
  /** The replaced Manager is the newest on purpose: without the rule it is the one opened. */
  const managers = (replacedLabels: Record<string, string> = {}) => [
    agent({ id: "mgr-third", createdAt: "2026-09-15T08:00:00.000Z", labels: marked }),
    agent({ id: "mgr-other", createdAt: "2026-09-15T09:00:00.000Z", labels: marked }),
    agent({ id: "mgr-replaced", createdAt: "2026-09-15T10:00:00.000Z", labels: { ...marked, ...replacedLabels } }),
  ];
  const expected = { agentId: "mgr-other", created: false, otherManagerIds: ["mgr-third"], modeNotice: null, toolsNotice: null, setupNotice: null };

  const managerIncident = (
    overrides: Partial<FallbackIncident> & Pick<FallbackIncident, "id" | "agentId" | "status">,
  ): FallbackIncident => ({
    role: "manager",
    workspaceId: WS,
    requestId: null,
    agentProvider: "bm-manager/claude-opus-5",
    agentModel: "claude-opus-5",
    parentId: null,
    managerId: overrides.agentId,
    class: "L1",
    signal: "failed",
    message: "You've hit your usage limit.",
    perModelWindow: false,
    resetsAt: null,
    candidate: null,
    detectedAt: "2026-09-21T09:00:00.000Z",
    decidedAt: null,
    waitUntil: null,
    replacementId: null,
    error: null,
    ...overrides,
  });
  const incidents = [
    managerIncident({ id: "fb-000000000001", agentId: "mgr-replaced", status: "switched", replacementId: "mgr-other" }),
    // Only `switched` counts: a Manager with a pending incident is still listed.
    managerIncident({ id: "fb-000000000002", agentId: "mgr-third", status: "pending" }),
  ];

  it("by its bm.replacedBy label: opens the other live Manager and never reports the replaced one", async () => {
    const fake = fakePaseo({ agents: managers({ "bm.replacedBy": "mgr-other" }) });

    const result = await ensureManager({ workspaceId: WS }, deps(fake.paseo));

    expect(result).toEqual(expected);
    expect(fake.createCalls).toEqual([]);
    expect(fake.archived).toEqual([]);
  });

  it.each([
    ["passed in", false],
    ["looked up from $HOME/.paseo-bm", true],
  ])("by a switched Manager incident only, the label missing — install home %s", async (_label, lookedUp) => {
    const home = lookedUp ? join(isolatedHome, ".paseo-bm") : mkdtempSync(join(tmpdir(), "bm-fallback-home-"));
    try {
      mkdirSync(home, { recursive: true });
      if (lookedUp) writeFileSync(join(home, "install.json"), JSON.stringify({ schemaVersion: 1 }));
      writeFileSync(join(home, "role-fallback-state.json"), JSON.stringify({ version: 1, incidents }));
      const fake = fakePaseo({ agents: managers() });

      const result = await ensureManager(
        { workspaceId: WS },
        lookedUp ? { paseo: fake.paseo, readInstructions: readManagerInstructions } : { ...deps(fake.paseo), home },
      );

      expect(result).toEqual(expected);
      expect(fake.createCalls).toEqual([]);
      expect(fake.archived).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("createManager — the one path that creates a Manager (delta 20260921 §4.5.2)", () => {
  it("creates a replacement like manager.ensure creates a Manager, plus its own labels and first message", async () => {
    const fake = fakePaseo();

    const result = await createManager(fake.paseo, WS, {
      providerSelection: "bm-manager-fallback-1/gpt-5.6-sol",
      modeId: "full-access",
      labels: { "bm.modeSet": "full-access", "bm.replaces": "mgr-old" },
      prompt: "BM-HANDOVER\nrole: manager",
      readInstructions: readManagerInstructions,
    });

    expect(result).toEqual({ agentId: "created-1", toolsNotice: null });
    expect(fake.createCalls).toEqual([
      {
        workspaceId: WS,
        options: {
          config: { provider: "bm-manager-fallback-1/gpt-5.6-sol", modeId: "full-access", systemPrompt: managerMd },
          title: "Beads Manager",
          labels: { "bm.role": "manager", "bm.version": PLUGIN_VERSION, "bm.modeSet": "full-access", "bm.replaces": "mgr-old" },
          prompt: "BM-HANDOVER\nrole: manager",
        },
      },
    ]);
  });

  it.each([
    ["bm-manager/gpt-5.6-sol", 'with profile "bm-manager"'],
    ["bm-manager-fallback-1/gpt-5.6-sol", 'with provider "bm-manager-fallback-1/gpt-5.6-sol"'],
  ])("a rejected create of %s names %s", async (providerSelection, named) => {
    const fake = fakePaseo({ createRejects: new Error("usage limit") });

    const error = await createManager(fake.paseo, WS, { providerSelection, labels: {}, readInstructions: readManagerInstructions }).catch(
      (e: unknown) => e,
    );

    expect((error as ManagerEnsureError).code).toBe("E_PROVIDER_UNAVAILABLE");
    expect((error as Error).message).toBe(`E_PROVIDER_UNAVAILABLE: could not create the Manager ${named}: usage limit`);
  });
});
