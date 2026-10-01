import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  ORCHESTRATOR_FIRST_PROMPT,
  ORCHESTRATOR_HOME_README,
  ORCHESTRATOR_INSTRUCTIONS_HASH,
  ORCHESTRATOR_TITLE,
  findOrchestratorAgent,
  handleOrchestratorOpen,
  handleOrchestratorOpenPreview,
  isOutdatedOrchestrator,
  orchestratorHomeOf,
  wakeableOrchestrator,
  type OrchestratorAgentDeps,
  type OrchestratorAgentPaseo,
} from "../plugin/server/orchestrator-agent";
import { toolsStaleSince } from "../plugin/server/agent-tools";
import { DASHBOARD_ERROR_CODES, DashboardError, orchestratorOpenPreviewRpc, orchestratorOpenRpc } from "../plugin/shared/contracts";
import { PLUGIN_VERSION } from "../plugin/shared/version";
import { ORCHESTRATOR_INSTRUCTIONS } from "../plugin/server/orchestrator-instructions";
import { fakePaseo } from "./helpers/fake-paseo";

/**
 * The one Orchestrator agent (Orchestrator design §3.3, ADR-014 decision 1,
 * REQ-075 a): `orchestrator.open-preview` and `orchestrator.open` against a
 * fake Paseo SDK and a temporary data folder named by `PASEO_BM_HOME` — never
 * the real HOME or a daemon.
 */

let root: string;
let home: string;
let deps: OrchestratorAgentDeps;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-orchestrator-agent-"));
  home = join(root, "data");
  deps = { env: { PASEO_BM_HOME: home }, homedir: () => root, log: () => {} };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const CLAUDE_MODES = [
  { id: "plan", label: "Plan", colorTier: "planning" },
  { id: "default", label: "Default", colorTier: "safe" },
  { id: "acceptEdits", label: "Accept edits", colorTier: "moderate" },
  { id: "auto", label: "Auto", colorTier: "moderate" },
  { id: "bypassPermissions", label: "Bypass permissions", colorTier: "dangerous" },
];

interface Agent {
  id: string;
  workspaceId: string;
  createdAt: string;
  status: string;
  provider: string;
  labels: Record<string, string>;
  archivedAt?: string | null;
}

interface FakeOptions {
  agents?: Agent[];
  profile?: Record<string, unknown> | null;
  modes?: Array<{ id: string; label: string; colorTier: string }>;
  available?: string[];
  /** The just-created agent reports this status. */
  createdStatus?: string;
}

/** The shared fake SDK: the Orchestrator's alias and profile configured; a creation lands in its list, as on the daemon. */
function daemonWith(options: FakeOptions & { timelines?: Record<string, Array<Record<string, unknown>>> } = {}) {
  const profile =
    options.profile === undefined
      ? { id: "bm-orchestrator", name: "Beads Orchestrator", provider: "bm-orchestrator", model: "claude-opus-5-5" }
      : options.profile;
  return fakePaseo<OrchestratorAgentPaseo>({
    agents: options.agents ?? [],
    timelines: options.timelines ?? {},
    providers: { available: options.available ?? ["claude", "codex"], modes: () => options.modes ?? CLAUDE_MODES },
    config: {
      providers: { "bm-orchestrator": { extends: "claude", label: "Beads Orchestrator" } },
      agentProfiles: profile === null ? [] : [profile],
    },
    created: async (_request, { n }) => {
      // Let an overlapping call run before this one is visible, as a daemon round trip would.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { id: `agent-${n}`, createdAt: new Date(Date.UTC(2026, 8, 28, 10, n)).toISOString(), status: options.createdStatus ?? "running", lastError: "provider missing" };
    },
  });
}

function codeOf(error: unknown): string | null {
  return error instanceof DashboardError ? error.code : null;
}

const orchestratorAgent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  workspaceId: "wks-elsewhere",
  createdAt: "2026-09-28T09:00:00.000Z",
  status: "idle",
  provider: "bm-orchestrator/claude-opus-5-5",
  // A current Orchestrator: created with this plugin's instructions (design §3.3).
  labels: { "bm.role": "orchestrator", "bm.orchestrator": "main", "bm.version": "0.5.0", "bm.instructions": ORCHESTRATOR_INSTRUCTIONS_HASH },
  ...extra,
});

/** An Orchestrator created before its instructions were labelled, as on the owner's machine on 2026-09-29. */
const OLD_LABELS = { "bm.role": "orchestrator", "bm.orchestrator": "main", "bm.version": "0.5.0" };

describe("orchestrator.open", () => {
  it("creates the Orchestrator once in its own workspace, then reopens the same agent", async () => {
    const fake = daemonWith();

    const first = await handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps);
    const second = await handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps);

    expect(first).toEqual({ agentId: "agent-1", created: true });
    expect(second).toEqual({ agentId: "agent-1", created: false });
    expect(fake.creates).toHaveLength(1);
    expect(fake.api.workspaces.open).toHaveBeenCalledTimes(1);
    expect(fake.api.workspaces.open).toHaveBeenCalledWith({ cwd: orchestratorHomeOf(home) });
    expect(fake.creates[0]!.workspaceId).toBe("wks-own");
  });

  it("gives it the labels, the title, the profile's model and a short first prompt", async () => {
    const fake = daemonWith();

    await handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps);

    const request = fake.creates[0]!.options;
    expect(request.labels).toEqual({
      "bm.role": "orchestrator",
      "bm.orchestrator": "main",
      "bm.version": PLUGIN_VERSION,
      "bm.instructions": ORCHESTRATOR_INSTRUCTIONS_HASH,
    });
    expect(request.title).toBe(ORCHESTRATOR_TITLE);
    expect(request.title).toBe("Beads Orchestrator");
    expect(request.config.provider).toBe("bm-orchestrator/claude-opus-5-5");
    expect(request.prompt).toBe(ORCHESTRATOR_FIRST_PROMPT);
    for (const tool of ["bm_projects", "bm_request", "bm_agent_messages", "bm_decisions", "bm_send_command", "bm_ask_owner", "bm_decide", "bm_predict", "bm_direct_worker", "bm_repo", "bm_note"]) {
      expect(request.prompt).toContain(tool);
    }
    expect(request.prompt).toMatch(/wait for the user/);
  });

  it("uses the bare alias when the profile names no model", async () => {
    const fake = daemonWith({ profile: { id: "bm-orchestrator", name: "Beads Orchestrator", provider: "bm-orchestrator" } });

    await handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps);

    expect(fake.creates[0]!.options.config.provider).toBe("bm-orchestrator");
  });

  it.each([
    ["Claude's modes", CLAUDE_MODES, undefined],
    ["Claude's modes with bypassPermissions on the profile", CLAUDE_MODES, "bypassPermissions"],
    ["Claude's modes with plan on the profile", CLAUDE_MODES, "plan"],
    [
      "Codex's modes",
      [
        { id: "auto", label: "Auto", colorTier: "moderate" },
        { id: "auto-review", label: "Auto review", colorTier: "moderate" },
        { id: "full-access", label: "Full access", colorTier: "dangerous" },
      ],
      undefined,
    ],
    [
      "modes without auto",
      [
        { id: "plan", label: "Plan", colorTier: "planning" },
        { id: "default", label: "Default", colorTier: "safe" },
        { id: "yolo", label: "Yolo", colorTier: "dangerous" },
      ],
      undefined,
    ],
  ] as Array<[string, Array<{ id: string; label: string; colorTier: string }>, string | undefined]>)(
    "chooses its mode by the Reviewer rule, never dangerous or planning (%s)",
    async (_case, modes, profileMode) => {
      const fake = daemonWith({
        modes,
        profile: { id: "bm-orchestrator", name: "Beads Orchestrator", provider: "bm-orchestrator", model: "m", ...(profileMode ? { modeId: profileMode } : {}) },
      });

      await handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps);

      const modeId = (fake.creates[0]!.options.config as { modeId?: string }).modeId;
      const chosen = modes.find((mode) => mode.id === modeId);
      expect(chosen).toBeDefined();
      expect(["dangerous", "planning"]).not.toContain(chosen!.colorTier);
      expect(fake.api.providers.listModes).toHaveBeenCalledWith("bm-orchestrator", { cwd: orchestratorHomeOf(home) });
    },
  );

  it("creates its home folder (0700) with a README", async () => {
    const fake = daemonWith();

    await handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps);

    const folder = orchestratorHomeOf(home);
    expect(folder).toBe(join(home, "orchestrator", "home"));
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(folder, "README.md"), "utf8")).toBe(ORCHESTRATOR_HOME_README);
    // It says when a command goes out without a click — where the owner delegated it (autonomy design §B.9) — and the limits.
    expect(ORCHESTRATOR_HOME_README).toMatch(/only where you delegated what\s+the command does, in Settings → Autonomy/);
    expect(ORCHESTRATOR_HOME_README).toMatch(/commit, push or deploy/);
    expect(ORCHESTRATOR_HOME_README).not.toMatch(/unless you approve it/);
  });

  it("reopens an Orchestrator in any workspace, the newest one, without touching the folder", async () => {
    const fake = daemonWith({
      agents: [
        orchestratorAgent("old", { createdAt: "2026-09-27T09:00:00.000Z" }),
        orchestratorAgent("new", { createdAt: "2026-09-28T09:00:00.000Z" }),
      ],
    });

    await expect(handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps)).resolves.toEqual({ agentId: "new", created: false });
    expect(fake.creates).toEqual([]);
    expect(fake.api.workspaces.open).not.toHaveBeenCalled();
    expect(existsSync(orchestratorHomeOf(home))).toBe(false);
  });

  it("does not count an archived Orchestrator, nor an agent without both labels", async () => {
    const fake = daemonWith({
      agents: [
        orchestratorAgent("archived", { archivedAt: "2026-09-28T09:30:00.000Z" }),
        // A first-design assessment agent: bm.role=orchestrator but not the main one.
        orchestratorAgent("assessment", { labels: { "bm.role": "orchestrator", "bm.assessmentId": "a-1" } }),
        orchestratorAgent("impostor", { provider: "claude", labels: { "bm.orchestrator": "main" } }),
      ],
    });

    await expect(handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps)).resolves.toEqual({ agentId: "agent-1", created: true });
    await expect(findOrchestratorAgent(fake.paseo)).resolves.toMatchObject({ id: "agent-1" });
  });

  it("creates one agent when two opens overlap", async () => {
    const fake = daemonWith();

    const [a, b] = await Promise.all([
      handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps),
      handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps),
    ]);

    expect(fake.creates).toHaveLength(1);
    expect(a.agentId).toBe(b.agentId);
  });

  it("keeps an agent whose provider did not start, and reopens it next time (never archives)", async () => {
    const fake = daemonWith({ createdStatus: "error" });

    await expect(handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps)).resolves.toEqual({ agentId: "agent-1", created: true });
    await expect(handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps)).resolves.toEqual({ agentId: "agent-1", created: false });
    expect(fake.archives).toEqual([]);
    expect(fake.sends).toEqual([]);
  });

  it.each([
    ["there is no bm-orchestrator profile", { profile: null }],
    ["the provider is not available", { available: ["codex"] }],
  ] as Array<[string, FakeOptions]>)("fails E_ORCHESTRATOR_UNAVAILABLE when %s, and creates nothing", async (_case, options) => {
    const fake = daemonWith(options);

    const error = await handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps).catch((caught: unknown) => caught);

    expect(codeOf(error)).toBe("E_ORCHESTRATOR_UNAVAILABLE");
    expect(fake.creates).toEqual([]);
    expect(fake.api.workspaces.open).not.toHaveBeenCalled();
    expect(existsSync(orchestratorHomeOf(home))).toBe(false);
    expect(DASHBOARD_ERROR_CODES).toContain("E_ORCHESTRATOR_UNAVAILABLE");
  });

  it("fails E_DATA_HOME_UNAVAILABLE without a usable data folder, and creates nothing", async () => {
    const fake = daemonWith();

    const error = await handleOrchestratorOpen({ confirmed: true }, fake.paseo, {
      env: { PASEO_BM_HOME: "relative/bm" },
      homedir: () => root,
      log: () => {},
    }).catch((caught: unknown) => caught);

    expect(codeOf(error)).toBe("E_DATA_HOME_UNAVAILABLE");
    expect(fake.creates).toEqual([]);
    expect(fake.api.workspaces.open).not.toHaveBeenCalled();
  });

  it("fails E_DATA_HOME_UNAVAILABLE, not a write code, when the data folder cannot be created (code review 2026-09-30 §3.2)", async () => {
    const fake = daemonWith();
    writeFileSync(join(root, "plain-file"), "");

    const error = await handleOrchestratorOpen({ confirmed: true }, fake.paseo, {
      env: { PASEO_BM_HOME: join(root, "plain-file", "bm") },
      homedir: () => root,
      log: () => {},
    }).catch((caught: unknown) => caught);

    expect(codeOf(error)).toBe("E_DATA_HOME_UNAVAILABLE");
    expect(fake.creates).toEqual([]);
  });

  it("recreate: a stale Orchestrator is replaced by a new one, which the next open returns; the old one is left alone", async () => {
    const stale = orchestratorAgent("stale", { createdAt: "2026-09-28T08:00:00.000Z" });
    const fake = daemonWith({ agents: [stale] });
    // The endpoint's secret was made at 09:00 (design §5.1).
    const isToolsStale = vi.fn(toolsStaleSince(new Date("2026-09-28T09:00:00.000Z")));

    // Without recreate, the stale one is reopened as it is.
    await expect(handleOrchestratorOpen({ confirmed: true }, fake.paseo, { ...deps, isToolsStale })).resolves.toEqual({ agentId: "stale", created: false });
    expect(fake.creates).toEqual([]);

    await expect(handleOrchestratorOpen({ confirmed: true, recreate: true }, fake.paseo, { ...deps, isToolsStale })).resolves.toEqual({
      agentId: "agent-1",
      created: true,
    });
    expect(isToolsStale).toHaveBeenCalledWith({ id: "stale", createdAt: "2026-09-28T08:00:00.000Z" });
    expect(fake.creates).toHaveLength(1);
    expect(fake.creates[0]!.options.labels).toMatchObject({ "bm.role": "orchestrator", "bm.orchestrator": "main" });
    // Never archived, never messaged: the user owns it.
    expect(fake.archives).toEqual([]);
    expect(fake.sends).toEqual([]);
    expect(fake.agents.find((entry) => entry.id === "stale")?.archivedAt).toBeUndefined();

    // The new one is the Orchestrator from now on, and it is not stale: a second recreate creates nothing.
    await expect(handleOrchestratorOpen({ confirmed: true, recreate: true }, fake.paseo, { ...deps, isToolsStale })).resolves.toEqual({
      agentId: "agent-1",
      created: false,
    });
    await expect(findOrchestratorAgent(fake.paseo)).resolves.toMatchObject({ id: "agent-1" });
    expect(fake.creates).toHaveLength(1);
  });

  it("recreate returns an Orchestrator that still has its tools, and creates one when there is none", async () => {
    const fresh = orchestratorAgent("fresh", { createdAt: "2026-09-28T10:00:00.000Z" });
    const fake = daemonWith({ agents: [fresh] });
    const isToolsStale = toolsStaleSince(new Date("2026-09-28T09:00:00.000Z"));
    await expect(handleOrchestratorOpen({ confirmed: true, recreate: true }, fake.paseo, { ...deps, isToolsStale })).resolves.toEqual({
      agentId: "fresh",
      created: false,
    });
    // Without the check (no endpoint), nothing is ever stale.
    await expect(handleOrchestratorOpen({ confirmed: true, recreate: true }, fake.paseo, deps)).resolves.toEqual({ agentId: "fresh", created: false });
    expect(fake.creates).toEqual([]);

    const empty = daemonWith();
    await expect(handleOrchestratorOpen({ confirmed: true, recreate: true }, empty.paseo, { ...deps, isToolsStale })).resolves.toEqual({
      agentId: "agent-1",
      created: true,
    });
  });

  it("recreate: an outdated Orchestrator (instructions label missing or different) is replaced; without recreate it is reopened", async () => {
    for (const labels of [OLD_LABELS, { ...OLD_LABELS, "bm.instructions": "0123456789ab" }]) {
      const fake = daemonWith({ agents: [orchestratorAgent("old", { labels })] });
      await expect(handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps)).resolves.toEqual({ agentId: "old", created: false });
      await expect(handleOrchestratorOpen({ confirmed: true, recreate: true }, fake.paseo, deps)).resolves.toEqual({ agentId: "agent-1", created: true });
      expect(fake.creates[0]!.options.labels!["bm.instructions"]).toBe(ORCHESTRATOR_INSTRUCTIONS_HASH);
      await expect(handleOrchestratorOpen({ confirmed: true, recreate: true }, fake.paseo, deps)).resolves.toEqual({ agentId: "agent-1", created: false });
      expect(fake.creates).toHaveLength(1);
      expect(fake.archives).toEqual([]);
      expect(fake.sends).toEqual([]);
    }
  });

  it("the instructions label is a short SHA-256 of the Orchestrator's instructions", () => {
    expect(ORCHESTRATOR_INSTRUCTIONS_HASH).toBe(createHash("sha256").update(ORCHESTRATOR_INSTRUCTIONS).digest("hex").slice(0, 12));
    expect(isOutdatedOrchestrator({ labels: { "bm.instructions": ORCHESTRATOR_INSTRUCTIONS_HASH } })).toBe(false);
    expect(isOutdatedOrchestrator({ labels: OLD_LABELS })).toBe(true);
    expect(isOutdatedOrchestrator({})).toBe(true);
  });

  it("toolsStaleSince: created before the secret is stale; after it, unknown, or without a secret is not", () => {
    const since = new Date("2026-09-28T09:00:00.000Z");
    expect(toolsStaleSince(since)({ createdAt: "2026-09-28T08:59:59.000Z" })).toBe(true);
    expect(toolsStaleSince(since)({ createdAt: "2026-09-28T09:00:00.000Z" })).toBe(false);
    expect(toolsStaleSince(since)({ createdAt: null })).toBe(false);
    expect(toolsStaleSince(since)({ createdAt: "not a time" })).toBe(false);
    expect(toolsStaleSince(null)({ createdAt: "2026-09-28T08:00:00.000Z" })).toBe(false);
  });

  it("refuses a call that skipped the confirmation", () => {
    expect(orchestratorOpenRpc.input.safeParse({ confirmed: true, recreate: true }).success).toBe(true);
    expect(orchestratorOpenRpc.input.safeParse({ confirmed: true, recreate: false }).success).toBe(false);
    expect(orchestratorOpenRpc.input.safeParse({ recreate: true }).success).toBe(false);
    expect(orchestratorOpenRpc.input.safeParse({}).success).toBe(false);
    expect(orchestratorOpenRpc.input.safeParse({ confirmed: false }).success).toBe(false);
    expect(orchestratorOpenRpc.input.safeParse({ confirmed: true }).success).toBe(true);
    expect(orchestratorOpenRpc.input.safeParse({ confirmed: true, workspaceId: "wks-1" }).success).toBe(true);
  });
});

describe("wakeableOrchestrator: the Orchestrator a plugin notice wakes (design §3.3)", () => {
  const isToolsStale = toolsStaleSince(new Date("2026-09-28T09:00:00.000Z"));

  it("returns a current Orchestrator as it is, and creates nothing", async () => {
    const fake = daemonWith({ agents: [orchestratorAgent("current", { createdAt: "2026-09-28T10:00:00.000Z" })] });
    await expect(wakeableOrchestrator(fake.paseo, { ...deps, isToolsStale })).resolves.toMatchObject({ id: "current" });
    expect(fake.creates).toEqual([]);
    expect(fake.api.workspaces.open).not.toHaveBeenCalled();
  });

  it("returns null when there is none: never creates one the owner never opened", async () => {
    const fake = daemonWith({ agents: [orchestratorAgent("archived", { archivedAt: "2026-09-28T09:30:00.000Z", labels: OLD_LABELS })] });
    await expect(wakeableOrchestrator(fake.paseo, { ...deps, isToolsStale })).resolves.toBeNull();
    expect(fake.creates).toEqual([]);
    expect(existsSync(orchestratorHomeOf(home))).toBe(false);
  });

  it.each([
    ["outdated", { labels: OLD_LABELS, createdAt: "2026-09-28T10:00:00.000Z" }, "has outdated instructions"],
    ["tools-stale", { createdAt: "2026-09-28T08:00:00.000Z" }, "lost its tools"],
  ] as Array<[string, Partial<Agent>, string]>)("replaces a %s Orchestrator once, logs one line, and leaves the old one alone", async (_case, extra, reason) => {
    const fake = daemonWith({ agents: [orchestratorAgent("old", extra)] });
    const log = vi.fn();

    const woken = await wakeableOrchestrator(fake.paseo, { ...deps, isToolsStale, log });
    expect(woken).toMatchObject({ id: "agent-1" });
    expect(fake.creates).toHaveLength(1);
    const request = fake.creates[0]!.options;
    // Exactly as orchestrator.open creates it.
    expect(request.labels).toEqual({
      "bm.role": "orchestrator",
      "bm.orchestrator": "main",
      "bm.version": PLUGIN_VERSION,
      "bm.instructions": ORCHESTRATOR_INSTRUCTIONS_HASH,
    });
    expect(request.title).toBe(ORCHESTRATOR_TITLE);
    expect(request.prompt).toBe(ORCHESTRATOR_FIRST_PROMPT);
    expect(fake.api.workspaces.open).toHaveBeenCalledWith({ cwd: orchestratorHomeOf(home) });
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      `[paseo-bm] the Beads Orchestrator old ${reason}; created agent-1 to take over (the old one stays in your agent list)`,
    ]);
    // Never archived, never messaged.
    expect(fake.archives).toEqual([]);
    expect(fake.sends).toEqual([]);
    expect(fake.agents.find((entry) => entry.id === "old")?.archivedAt).toBeUndefined();

    // The new one is current: the next wake-up uses it and creates nothing.
    await expect(wakeableOrchestrator(fake.paseo, { ...deps, isToolsStale, log })).resolves.toMatchObject({ id: "agent-1" });
    expect(fake.creates).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("two wake-ups at once, or one with an older list, create one agent", async () => {
    const old = orchestratorAgent("old", { labels: OLD_LABELS });
    const fake = daemonWith({ agents: [old] });
    const [a, b] = await Promise.all([wakeableOrchestrator(fake.paseo, deps), wakeableOrchestrator(fake.paseo, deps)]);
    expect(a?.id).toBe("agent-1");
    expect(b?.id).toBe("agent-1");
    // A caller that listed before the replacement still gets the new one.
    await expect(wakeableOrchestrator(fake.paseo, deps, old)).resolves.toMatchObject({ id: "agent-1" });
    expect(fake.creates).toHaveLength(1);
  });

  describe("a fresh Orchestrator after a day (design §6B.6)", () => {
    const NOW = new Date("2026-09-29T12:00:00.000Z");
    const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
    const owner = (text: string, when: string) => ({ item: { type: "user_message", text, clientMessageId: `c-${when}` }, timestamp: when });
    const plugin = (text: string, when: string) => ({ item: { type: "user_message", text, clientMessageId: `n-${when}` }, timestamp: when });
    const reply = (text: string, when: string) => ({ item: { type: "assistant_message", text }, timestamp: when });

    /** The fake, with the Orchestrator's own chat readable through `timeline.refetch`. */
    const withChat = (agent: Agent, chat: Array<Record<string, unknown>>) => daemonWith({ agents: [agent], timelines: { [agent.id]: chat } });
    const dayDeps = (log = vi.fn()) => ({ ...deps, now: () => NOW, log });

    it("replaces one more than 24 hours old, idle, whose owner has been quiet for 2 hours, once, and leaves the old one alone", async () => {
      const chat = [
        plugin(ORCHESTRATOR_FIRST_PROMPT, hoursAgo(30)),
        owner("Watch invoice-app for me.", hoursAgo(29)),
        reply("Watching.", hoursAgo(29)),
        plugin("BM-EVENTS\nFrom the paseo-bm plugin, not the owner: 1 event.\n- request.finished — project wks-1", hoursAgo(1)),
      ];
      const fake = withChat(orchestratorAgent("old", { createdAt: hoursAgo(30) }), chat);
      const log = vi.fn();

      await expect(wakeableOrchestrator(fake.paseo, dayDeps(log))).resolves.toMatchObject({ id: "agent-1" });
      expect(fake.creates).toHaveLength(1);
      expect(fake.creates[0]!.options.labels).toMatchObject({ "bm.role": "orchestrator", "bm.orchestrator": "main" });
      expect(log.mock.calls.map(([line]) => line)).toEqual([
        "[paseo-bm] the Beads Orchestrator old is more than a day old; created agent-1 to take over (the old one stays in your agent list)",
      ]);
      expect(fake.archives).toEqual([]);
      expect(fake.sends).toEqual([]);
      // A caller holding the older list, or two wake-ups at once, get the new one and create no third.
      const old = fake.agents.find((entry) => entry.id === "old")!;
      const [a, b] = await Promise.all([wakeableOrchestrator(fake.paseo, dayDeps(), old), wakeableOrchestrator(fake.paseo, dayDeps(), old)]);
      expect([a?.id, b?.id]).toEqual(["agent-1", "agent-1"]);
      expect(fake.creates).toHaveLength(1);
    });

    it.each([
      ["created 23 hours ago", { createdAt: hoursAgo(23) }, [owner("Hi.", hoursAgo(20))]],
      ["running", { createdAt: hoursAgo(30), status: "running" }, [owner("Hi.", hoursAgo(20))]],
      ["with no known creation time", { createdAt: "" }, [owner("Hi.", hoursAgo(20))]],
      ["the owner wrote 90 minutes ago", { createdAt: hoursAgo(30) }, [owner("Hi.", hoursAgo(20)), owner("Send Q2.", hoursAgo(1.5)), plugin("BM-EVENTS\n- decision.opened — project wks-1", hoursAgo(0.5))]],
      ["an owner's message without a time", { createdAt: hoursAgo(30) }, [{ item: { type: "user_message", text: "Hi.", clientMessageId: "c-1" } }]],
      ["a chat that cannot be read", { createdAt: hoursAgo(30) }, []],
    ] as Array<[string, Partial<Agent>, Array<Record<string, unknown>>]>)("keeps a current one %s", async (_case, extra, chat) => {
      const fake = withChat(orchestratorAgent("current", extra), chat);
      await expect(wakeableOrchestrator(fake.paseo, dayDeps())).resolves.toMatchObject({ id: "current" });
      expect(fake.creates).toEqual([]);
    });

    it("reads its chat only once it is more than a day old and idle", async () => {
      const young = withChat(orchestratorAgent("young", { createdAt: hoursAgo(5) }), []);
      await wakeableOrchestrator(young.paseo, dayDeps());
      const busy = withChat(orchestratorAgent("busy", { createdAt: hoursAgo(30), status: "running" }), []);
      await wakeableOrchestrator(busy.paseo, dayDeps());
      expect([...young.refetches, ...busy.refetches]).toEqual([]);
    });

    it("a chat with only plugin notices and prompts counts as the owner's silence", async () => {
      const chat = [
        plugin(ORCHESTRATOR_FIRST_PROMPT, hoursAgo(26)),
        // The first prompt of an older version counts as silence too.
        plugin("The user opened you from the Orchestrator tab of paseo-bm.\nYour tools: bm_projects.", hoursAgo(25)),
        plugin("BM-EVENTS\n- request.stalled idle-unfinished — project wks-1", hoursAgo(0.2)),
      ];
      const fake = withChat(orchestratorAgent("old", { createdAt: hoursAgo(26) }), chat);
      await expect(wakeableOrchestrator(fake.paseo, dayDeps())).resolves.toMatchObject({ id: "agent-1" });
    });
  });

  it("a replacement that fails is logged, and the old one is woken instead", async () => {
    const fake = daemonWith({ agents: [orchestratorAgent("old", { labels: OLD_LABELS })], profile: null });
    const log = vi.fn();
    await expect(wakeableOrchestrator(fake.paseo, { ...deps, log })).resolves.toMatchObject({ id: "old" });
    expect(fake.creates).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[paseo-bm\] the Beads Orchestrator old has outdated instructions and could not be replaced: /);
  });
});

describe("orchestrator.open-preview", () => {
  it("says what would be created, in its own workspace, and creates nothing", async () => {
    const fake = daemonWith();

    const preview = await handleOrchestratorOpenPreview(fake.paseo);

    expect(preview).toEqual({ exists: false, provider: "claude", model: "claude-opus-5-5", workspace: "own" });
    expect(orchestratorOpenPreviewRpc.output.parse(preview)).toEqual(preview);
    expect(fake.creates).toEqual([]);
    expect(fake.api.workspaces.open).not.toHaveBeenCalled();
    expect(existsSync(join(home, "orchestrator"))).toBe(false);
  });

  it("says exists once the Orchestrator is there", async () => {
    const fake = daemonWith({ agents: [orchestratorAgent("o-1")] });

    await expect(handleOrchestratorOpenPreview(fake.paseo)).resolves.toEqual({
      exists: true,
      provider: "claude",
      model: "claude-opus-5-5",
      workspace: "own",
    });
  });

  it("still lets an existing Orchestrator be reopened when its profile is gone", async () => {
    const fake = daemonWith({ agents: [orchestratorAgent("o-1")], profile: null });

    await expect(handleOrchestratorOpenPreview(fake.paseo)).resolves.toMatchObject({ exists: true, model: null });
    await expect(handleOrchestratorOpen({ confirmed: true }, fake.paseo, deps)).resolves.toEqual({ agentId: "o-1", created: false });
  });

  it("fails E_ORCHESTRATOR_UNAVAILABLE when there is no agent and no profile", async () => {
    const fake = daemonWith({ profile: null });

    const error = await handleOrchestratorOpenPreview(fake.paseo).catch((caught: unknown) => caught);

    expect(codeOf(error)).toBe("E_ORCHESTRATOR_UNAVAILABLE");
  });
});
