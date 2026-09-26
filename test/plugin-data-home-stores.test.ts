import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCollector } from "../plugin/server/collector";
import { roleConfigRevision, type RoleConfigView } from "../plugin/server/config-writer";
import { handleTracesList, type DashboardPaseo } from "../plugin/server/dashboard-rpc";
import { ROLE_FALLBACK_FILE, handleRolesSaveFallback } from "../plugin/server/fallback-settings";
import { readRoleExtras } from "../plugin/server/role-extras";
import { handleRolesSaveExtra } from "../plugin/server/setup-rpc";
import { clearTraceStoreCache } from "../plugin/server/trace-store";

const readText = (path: string): string => readFileSync(path, "utf8");

/**
 * WP-401: every store works on a machine the installer never touched.
 *
 * This is the compatibility seam, so it is tested from the outside — the
 * collector hook, three RPCs — rather than at the resolver. What matters is
 * that a paseo.cafe install with no `install.json` records traces and settings
 * at all (it did not before), that a 0.3.x user's folder is still the one used,
 * and that an unusable folder disables rather than silently writing somewhere
 * else.
 */

const WS = "wks_1";

let root: string;
let realHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-data-stores-"));
  realHome = process.env["HOME"];
  clearTraceStoreCache();
});

afterEach(() => {
  if (realHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = realHome;
  delete process.env["PASEO_BM_HOME"];
  rmSync(root, { recursive: true, force: true });
});

/** Makes `~` the given directory, so the plugin's default `~/.paseo-bm` lands in it. */
function useHome(dir: string): string {
  mkdirSync(dir, { recursive: true });
  process.env["HOME"] = dir;
  return join(dir, ".paseo-bm");
}

// ── the collector ──────────────────────────────────────────────────────────

const REQ = "req-20260925T161934Z";

/**
 * A Manager turn as Paseo reports it, carrying the request id the way a real
 * prompt does. The Manager's turn is what opens a request, so one turn is
 * enough to make a trace the Dashboard can list.
 */
const turnEnded = () => ({
  agent: {
    id: "agent-manager",
    workspaceId: WS,
    parentAgentId: null,
    provider: "bm-manager/claude-opus-5",
    cwd: join(root, "repo"),
    title: "Beads Manager",
  },
  turnId: "turn-1",
  outcome: { kind: "completed" as const },
  timeline: [
    // `clientMessageId` is what marks a message the user typed themselves
    // (errata: an agent relay has none), and a trace segment starts at one.
    { type: "user_message" as const, text: `Fix the failing test.\n- \`requestId\`: \`${REQ}\``, messageId: "m1", clientMessageId: "c1" },
    { type: "assistant_message" as const, text: "Done." },
  ],
});

/** Registers the collector with its real resolver and returns the turn-ended hook. */
function collectorHook(): (event: unknown, context: unknown) => Promise<void> | void {
  const handlers = new Map<string, (event: unknown, context: unknown) => Promise<void> | void>();
  const on = vi.fn((name: string, handler: (event: unknown, context: unknown) => Promise<void> | void) => {
    handlers.set(name, handler);
    return () => {};
  });
  registerCollector({ on } as never, { log: () => {} });
  return handlers.get("agent.turn_ended")!;
}

// ── the RPCs ───────────────────────────────────────────────────────────────

function dashboardPaseo(): DashboardPaseo {
  return {
    agents: { list: vi.fn(async () => ({ entries: [] })) },
    workspaces: { list: vi.fn(async () => ({ entries: [{ id: WS, directory: join(root, "repo"), name: "repo" }] })) },
    config: { get: vi.fn(async () => ({ config: {} })) },
  };
}

const MODELS: Record<string, unknown[]> = {
  claude: [{ id: "claude-opus-5", label: "Opus 5", thinkingOptions: [] }],
  pi: [{ id: "pi-default", label: "Pi" }],
};

function fakeDaemon() {
  const state: { providers: Record<string, Record<string, unknown>>; agentProfiles: Array<Record<string, unknown>> } = {
    providers: {
      claude: { enabled: true },
      "bm-worker": { extends: "claude", label: "Beads Worker", paseoTools: { enabled: true } },
    },
    agentProfiles: [{ id: "bm-worker", name: "Worker", provider: "bm-worker", model: "claude-opus-5" }],
  };
  const paseo = {
    providers: {
      listAvailable: vi.fn(async () => ({ providers: ["claude", "pi"].map((provider) => ({ provider, available: true })) })),
      listModels: vi.fn(async (provider: string) => ({ provider, models: MODELS[provider] ?? [], error: null })),
      listModes: vi.fn(async (provider: string) => ({ provider, modes: [], error: null })),
    },
    config: {
      get: vi.fn(async () => ({ config: structuredClone(state) as RoleConfigView })),
      patch: vi.fn(async (patch: Record<string, unknown>) => {
        // Applied for real: `config-writer` reads back after every patch and
        // refuses a daemon that did not keep the values.
        for (const [id, entry] of Object.entries((patch["providers"] ?? {}) as Record<string, Record<string, unknown>>)) {
          state.providers[id] = { ...(state.providers[id] ?? {}), ...entry };
        }
        for (const id of (patch["removeProviders"] as string[] | undefined) ?? []) delete state.providers[id];
        if (patch["agentProfiles"] !== undefined) state.agentProfiles = structuredClone(patch["agentProfiles"]) as typeof state.agentProfiles;
        return {};
      }),
    },
  };
  return { paseo, revision: () => roleConfigRevision(state as RoleConfigView) };
}

const PI = { baseProvider: "pi", model: "pi-default", thinkingOptionId: null, modeId: null };

const saveFallback = (deps: { homedir?: () => string; home?: string | null }) => {
  const daemon = fakeDaemon();
  return handleRolesSaveFallback(
    { revision: daemon.revision(), role: "worker", policy: "ask", entries: [PI] },
    daemon.paseo,
    { log: () => {}, ...deps },
  );
};

/** Every store, exercised end to end against whatever folder is in force. */
async function everyStoreWorks(dataHome: string, homedir: () => string): Promise<void> {
  await collectorHook()(turnEnded() as never, { paseo: {} });

  const listed = await handleTracesList({ workspaceId: WS }, dashboardPaseo(), { homedir });
  expect(listed.traces).toHaveLength(1);
  expect(listed.traces[0]).toMatchObject({ requestId: REQ, traceId: `req:${REQ}` });

  await handleRolesSaveExtra({ role: "manager", text: "Answer in Vietnamese." }, {}, { homedir });
  expect(readRoleExtras(dataHome).manager).toBe("Answer in Vietnamese.");

  const saved = await saveFallback({ homedir });
  expect(saved.fallback.entries).toHaveLength(1);
  expect(JSON.parse(String(readText(join(dataHome, ROLE_FALLBACK_FILE))))).toMatchObject({
    roles: { worker: { policy: "ask" } },
  });
}

describe("a machine the installer never touched", () => {
  it("records traces and settings with no ~/.paseo-bm and no install.json", async () => {
    const dataHome = useHome(join(root, "fresh"));

    await everyStoreWorks(dataHome, () => join(root, "fresh"));
  });
});

describe("a 0.3.x user's folder", () => {
  it("is the one used, install.json and existing traces in place", async () => {
    const dataHome = useHome(join(root, "legacy"));
    mkdirSync(dataHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataHome, "install.json"), JSON.stringify({ schemaVersion: 1, version: "0.3.1" }));

    await everyStoreWorks(dataHome, () => join(root, "legacy"));

    // Nothing was moved, renamed or removed.
    expect(JSON.parse(readText(join(dataHome, "install.json"))).version).toBe("0.3.1");
  });
});

describe("a home.json pointer", () => {
  it("sends every store to the folder it names", async () => {
    const home = join(root, "pointed");
    const defaultHome = useHome(home);
    const custom = join(home, "custom-bm");
    mkdirSync(defaultHome, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(defaultHome, "home.json"),
      JSON.stringify({ schemaVersion: 1, home: custom, writtenBy: "paseo-bm@0.4.0", at: "2026-09-25T00:00:00.000Z" }),
    );

    await everyStoreWorks(custom, () => home);

    expect(() => readText(join(defaultHome, ROLE_FALLBACK_FILE))).toThrow();
  });
});

describe("a symlinked data folder", () => {
  it("is refused, and nothing is written through it", async () => {
    const home = join(root, "linked");
    const dataHome = useHome(home);
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, dataHome);

    await expect(
      handleRolesSaveExtra({ role: "manager", text: "x" }, {}, { homedir: () => home }),
    ).rejects.toMatchObject({ code: "E_TRACE_STORE_UNWRITABLE" });
    await expect(saveFallback({ homedir: () => home })).rejects.toMatchObject({
      code: "E_ROLE_SETTINGS_WRITE_FAILED",
    });
    expect(() => readText(join(outside, "role-extras.json"))).toThrow();
    expect(() => readText(join(outside, ROLE_FALLBACK_FILE))).toThrow();
  });
});

describe("a data folder that cannot be used", () => {
  const unsafe = () => {
    const home = useHome(join(root, "unsafe"));
    // `PASEO_BM_HOME` pointing at the home directory itself: the one case the
    // resolver must refuse outright rather than fall back (design §5.1).
    process.env["PASEO_BM_HOME"] = join(root, "unsafe");
    return home;
  };

  it("disables tracing instead of writing somewhere else", async () => {
    unsafe();
    await collectorHook()(turnEnded() as never, { paseo: {} });

    await expect(handleTracesList({ workspaceId: WS }, dashboardPaseo())).rejects.toMatchObject({
      code: "E_TRACE_STORE_UNWRITABLE",
    });
  });

  it("names the data folder and the reason in every message, with the codes unchanged", async () => {
    unsafe();

    await expect(handleRolesSaveExtra({ role: "manager", text: "x" }, {})).rejects.toThrow(
      /^E_ROLE_EXTRA_INVALID: cannot save: paseo-bm cannot use its data folder \(.+\)$/,
    );
    await expect(saveFallback({})).rejects.toThrow(
      /^E_ROLE_SETTINGS_WRITE_FAILED: paseo-bm cannot use its data folder \(.+\); see Setup$/,
    );
  });
});
