import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentLabeller, registerAgentLabels } from "../plugin/server/agent-labels";
import { createAlertStore, raiseInboxAlert } from "../plugin/server/alert-store";
import { fakePaseo } from "./helpers/fake-paseo";
import {
  checkRolePairing,
  describeRolePairingMismatch,
  raiseRolePairingAlert,
  rolePairingAlertOf,
  rolePairingMismatch,
  type PairingPaseo,
  type RolePairingMismatch,
} from "../plugin/server/role-pairing";

/**
 * The role pairing (REQ-116 b, design §A.10): only a Manager creates Workers,
 * only a Worker creates Reviewers. Checked on `agent.created`, because the
 * creation hook never sees the creator (run note 20260929).
 */

/** The shared fake SDK holding agents with these providers; an Error is what that agent's refresh rejects with. `reads` are the refreshes. */
function paseoWith(providers: Record<string, string | Error | null>) {
  const fake = fakePaseo<PairingPaseo>({
    agents: Object.entries(providers).flatMap(([id, provider]) => (typeof provider === "string" ? [{ id, provider }] : [])),
  });
  for (const [id, provider] of Object.entries(providers)) if (provider instanceof Error) fake.handle(id).refresh.mockRejectedValue(provider);
  return { paseo: fake.paseo, reads: fake.refreshes };
}

describe("rolePairingMismatch", () => {
  it.each([
    ["a Worker created by a Manager", "bm-worker/claude-opus-5-5", "bm-manager/claude-opus-5-5"],
    ["a fallback Worker created by a Manager", "bm-worker-fallback-1/gpt-5.6", "bm-manager"],
    ["a Reviewer created by a Worker", "bm-reviewer", "bm-worker"],
    ["a Reviewer created by a fallback Worker", "bm-reviewer-fallback-2/gpt-5.6", "bm-worker-fallback-1"],
  ])("allows %s", (_name, provider, creator) => {
    expect(rolePairingMismatch({ id: "a1", provider, parentAgentId: "p1" }, creator)).toBeNull();
  });

  it.each([
    ["a Manager", "bm-manager"],
    ["an Orchestrator", "bm-orchestrator"],
    ["a plain agent", "claude"],
  ])("does not apply to %s", (_name, provider) => {
    expect(rolePairingMismatch({ id: "a1", provider, parentAgentId: "p1" }, "claude")).toBeNull();
  });

  it("does not apply to a Worker or Reviewer without a creator agent (the user or the plugin created it)", () => {
    expect(rolePairingMismatch({ id: "w1", provider: "bm-worker", parentAgentId: null }, null)).toBeNull();
    expect(rolePairingMismatch({ id: "r1", provider: "bm-reviewer", parentAgentId: "  " }, null)).toBeNull();
    expect(rolePairingMismatch({ id: "r2", provider: "bm-reviewer" }, null)).toBeNull();
  });

  it.each([
    ["a Worker created by a Worker", "bm-worker", "bm-worker", "worker", "manager"],
    ["a Worker created by a Reviewer", "bm-worker", "bm-reviewer", "reviewer", "manager"],
    ["a Worker created by the Orchestrator", "bm-worker", "bm-orchestrator", "orchestrator", "manager"],
    ["a Reviewer created by a Manager", "bm-reviewer/gpt-5.6", "bm-manager", "manager", "worker"],
    ["a Reviewer created by a Reviewer", "bm-reviewer", "bm-reviewer-fallback-1", "reviewer", "worker"],
  ] as const)("flags %s", (_name, provider, creator, creatorRole, requiredRole) => {
    expect(rolePairingMismatch({ id: "a1", provider, parentAgentId: "p1", workspaceId: "wks_1" }, creator)).toEqual({
      agentId: "a1",
      workspaceId: "wks_1",
      role: provider.startsWith("bm-worker") ? "worker" : "reviewer",
      provider,
      creatorId: "p1",
      creatorProvider: creator,
      creatorRole,
      requiredRole,
    });
  });

  it("flags a Worker or Reviewer created by an agent that is not paseo-bm's, or whose provider is unknown", () => {
    expect(rolePairingMismatch({ id: "w1", provider: "bm-worker", parentAgentId: "p1" }, "claude")?.creatorRole).toBeNull();
    expect(rolePairingMismatch({ id: "r1", provider: "bm-reviewer", parentAgentId: "p1" }, null)?.requiredRole).toBe("worker");
  });

  it("never throws on a malformed agent", () => {
    expect(rolePairingMismatch(null as never, "bm-manager")).toBeNull();
    expect(rolePairingMismatch({ id: "x", provider: 42 as never, parentAgentId: "p1" }, "bm-manager")).toBeNull();
  });
});

describe("describeRolePairingMismatch", () => {
  const base: RolePairingMismatch = {
    agentId: "w1",
    workspaceId: null,
    role: "worker",
    provider: "bm-worker",
    creatorId: "r9",
    creatorProvider: "bm-reviewer",
    creatorRole: "reviewer",
    requiredRole: "manager",
  };

  it("names the agent, its creator and the rule", () => {
    expect(describeRolePairingMismatch(base)).toBe(
      "Beads Worker w1 was created by Reviewer r9; only a Beads Manager creates a Beads Worker.",
    );
  });

  it("names a creator that is not a paseo-bm agent by its provider", () => {
    expect(
      describeRolePairingMismatch({ ...base, role: "reviewer", provider: "bm-reviewer", creatorProvider: "codex", creatorRole: null, requiredRole: "worker" }),
    ).toBe("Reviewer w1 was created by agent r9, which is not a paseo-bm agent (provider codex); only a Beads Worker creates a Reviewer.");
  });
});

describe("raiseRolePairingAlert", () => {
  const mismatch = rolePairingMismatch({ id: "w1", provider: "bm-worker", parentAgentId: "w0" }, "bm-worker")!;

  it("logs one line while no alerts store is wired", async () => {
    const log = vi.fn();
    await raiseRolePairingAlert(mismatch, { log });
    expect(log.mock.calls).toEqual([
      ["[paseo-bm] role pairing: Beads Worker w1 was created by Beads Worker w0; only a Beads Manager creates a Beads Worker."],
    ]);
  });

  it("hands the mismatch to the alerts store when one is wired, and logs nothing", async () => {
    const log = vi.fn();
    const raiseAlert = vi.fn();
    await raiseRolePairingAlert(mismatch, { log, raiseAlert });
    expect(raiseAlert).toHaveBeenCalledWith(mismatch);
    expect(log).not.toHaveBeenCalled();
  });

  it("wired to the Inbox alerts store (design §A.8): one pairing-mismatch alert per agent, raised once, no log line", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-role-pairing-"));
    try {
      const home = join(root, "data");
      const log = vi.fn();
      const withWorkspace = { ...mismatch, workspaceId: "wks_1" };
      const raiseAlert = (found: RolePairingMismatch) => void raiseInboxAlert(rolePairingAlertOf(found), { env: { PASEO_BM_HOME: home }, homedir: () => root });
      await raiseRolePairingAlert(withWorkspace, { log, raiseAlert });
      await raiseRolePairingAlert(withWorkspace, { log, raiseAlert });
      expect(createAlertStore(home).list()).toEqual([
        expect.objectContaining({ workspaceId: "wks_1", kind: "pairing-mismatch", subject: "w1", clearedAt: null, detail: describeRolePairingMismatch(withWorkspace) }),
      ]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the log line when the store fails, and never throws", async () => {
    const log = vi.fn();
    await expect(raiseRolePairingAlert(mismatch, { log, raiseAlert: () => Promise.reject(new Error("disk full")) })).resolves.toBeUndefined();
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      "[paseo-bm] could not record the role pairing alert: disk full",
      expect.stringMatching(/^\[paseo-bm\] role pairing: Beads Worker w1/),
    ]);
  });
});

describe("checkRolePairing", () => {
  it("reads the creator's provider and raises nothing for an allowed pair", async () => {
    const { paseo, reads } = paseoWith({ m1: "bm-manager/claude-opus-5-5" });
    const raiseAlert = vi.fn();
    expect(await checkRolePairing({ id: "w1", provider: "bm-worker", parentAgentId: "m1" }, paseo, { raiseAlert })).toBe("paired");
    expect(reads).toEqual(["m1"]);
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it("raises the alert for a mismatched pair", async () => {
    const { paseo } = paseoWith({ m1: "bm-manager" });
    const raiseAlert = vi.fn();
    expect(await checkRolePairing({ id: "r1", provider: "bm-reviewer", parentAgentId: "m1", workspaceId: "wks_1" }, paseo, { raiseAlert })).toBe(
      "mismatch",
    );
    expect(raiseAlert).toHaveBeenCalledWith(expect.objectContaining({ agentId: "r1", creatorId: "m1", creatorRole: "manager", requiredRole: "worker" }));
  });

  it("reads nothing for an agent the rule does not cover", async () => {
    const { paseo, reads } = paseoWith({});
    expect(await checkRolePairing({ id: "m1", provider: "bm-manager", parentAgentId: null }, paseo)).toBe("not-checked");
    expect(await checkRolePairing({ id: "w1", provider: "bm-worker", parentAgentId: null }, paseo)).toBe("not-checked");
    expect(await checkRolePairing({ id: "o1", provider: "bm-orchestrator", parentAgentId: "x" }, paseo)).toBe("not-checked");
    expect(reads).toEqual([]);
  });

  it.each([
    ["the read fails", new Error("gone"), "reading its creator m1 failed (gone)"],
    ["Paseo returns no snapshot", null, "reading its creator m1 failed (Paseo returned no snapshot for it)"],
  ])("logs one line and raises nothing when %s", async (_name, answer, text) => {
    const { paseo } = paseoWith({ m1: answer });
    const log = vi.fn();
    const raiseAlert = vi.fn();
    expect(await checkRolePairing({ id: "w1", provider: "bm-worker", parentAgentId: "m1" }, paseo, { log, raiseAlert })).toBe("unreadable");
    expect(log.mock.calls).toEqual([[`[paseo-bm] could not check who created w1: ${text}.`]]);
    expect(raiseAlert).not.toHaveBeenCalled();
  });

  it("is unreadable without a Paseo handle", async () => {
    const log = vi.fn();
    expect(await checkRolePairing({ id: "w1", provider: "bm-worker", parentAgentId: "m1" }, undefined, { log })).toBe("unreadable");
  });
});

describe("the pairing check on agent.created", () => {
  function host() {
    const handlers: Record<string, (event: unknown, context: unknown) => Promise<void>> = {};
    return {
      handlers,
      host: {
        on: (name: string, handler: (event: unknown, context: unknown) => Promise<void>) => {
          handlers[name] = handler;
          return () => {};
        },
      },
    };
  }

  it("raises the alert for a Worker a Worker created, from the event's parentAgentId", async () => {
    const { host: h, handlers } = host();
    const raiseAlert = vi.fn();
    const labeller = createAgentLabeller({ cli: { find: () => null, run: async () => ({ code: 0, output: "{}", timedOut: false }) }, log: () => {} });
    registerAgentLabels(h as never, labeller, { raiseAlert, log: () => {} });
    const withRefresh = {
      agents: {
        ref: (id: string) => ({
          refresh: async () => (id === "w0" ? { agent: { provider: "bm-worker", labels: { "bm.role": "worker" } } } : { agent: { labels: { "bm.role": "worker" } } }),
        }),
        list: async () => ({ entries: [] }),
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await handlers["agent.created"]!(
      { agent: { id: "w1", provider: "bm-worker", parentAgentId: "w0", workspaceId: "wks_1", cwd: "/r", title: null } },
      { paseo: withRefresh },
    );
    warn.mockRestore();
    expect(raiseAlert).toHaveBeenCalledWith(expect.objectContaining({ agentId: "w1", creatorId: "w0", creatorRole: "worker", workspaceId: "wks_1" }));
  });

  it("a handoff's successor, created by the Manager, pairs; the same hook hands it to the handoff check (autonomy design §G.6)", async () => {
    const { host: h, handlers } = host();
    const raiseAlert = vi.fn();
    const onCreated = vi.fn(async () => null);
    const labeller = createAgentLabeller({ cli: { find: () => null, run: async () => ({ code: 0, output: "{}", timedOut: false }) }, log: () => {} });
    registerAgentLabels(h as never, labeller, { raiseAlert, log: () => {} }, onCreated);
    const withRefresh = {
      agents: {
        ref: (id: string) => ({
          refresh: async () =>
            id === "m0" ? { agent: { provider: "bm-manager", labels: { "bm.role": "manager" } } } : { agent: { labels: { "bm.role": "worker", "bm.handoffFrom": "w0", "bm.requestId": "req-1" } } },
        }),
        list: async () => ({ entries: [] }),
      },
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await handlers["agent.created"]!({ agent: { id: "w1", provider: "bm-worker", parentAgentId: "m0", workspaceId: "wks_1", cwd: "/r", title: null } }, { paseo: withRefresh });
    warn.mockRestore();
    expect(raiseAlert).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith({ id: "w1", provider: "bm-worker", parentAgentId: "m0", workspaceId: "wks_1" }, withRefresh);
  });
});
