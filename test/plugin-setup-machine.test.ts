import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PI_SIGN_IN_GUIDANCE,
  grantAgentTools,
  installKind,
  loginStateFromDiagnostic,
  providerLogins,
} from "../plugin/server/setup-machine";
import { readSetupState, updateSetupState } from "../plugin/server/setup-state";
import { setupGrantAgentToolsRpc } from "../plugin/shared/contracts";

/**
 * WP-403: Paseo's machine-wide agent-tools switch (design §7.13.3).
 *
 * The property under test is the ORDER, not the switch: the record of what was
 * there before is written first, because "Remove paseo-bm's settings" can only
 * undo exactly what paseo-bm did if that record exists. A test that only
 * checked the final value would pass on code that could never be undone.
 */

let home: string;
const deps = () => ({ env: {}, homedir: () => home, now: () => new Date("2026-09-25T10:00:00.000Z") });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-setup-machine-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function fakeDaemon(injectIntoAgents = false, options: { patchFails?: boolean; keepsIt?: boolean } = {}) {
  const state: { providers: Record<string, unknown>; agentProfiles: unknown[]; mcp: { injectIntoAgents: boolean } } = {
    providers: {},
    agentProfiles: [],
    mcp: { injectIntoAgents },
  };
  const patches: Array<Record<string, unknown>> = [];
  const paseo = {
    config: {
      get: vi.fn(async () => ({ config: structuredClone(state) })),
      patch: vi.fn(async (patch: Record<string, unknown>) => {
        if (options.patchFails === true) throw new Error("Request failed: daemon.mcp is read-only");
        patches.push(structuredClone(patch));
        const mcp = patch["mcp"] as { injectIntoAgents?: boolean } | undefined;
        // `keepsIt: false` is a daemon that answers yes and changes nothing.
        if (mcp?.injectIntoAgents !== undefined && options.keepsIt !== false) state.mcp.injectIntoAgents = mcp.injectIntoAgents;
        return {};
      }),
    },
  };
  return { paseo, patches, state: () => state };
}

describe("setup.grant-agent-tools", () => {
  it("records what was there before, then turns the switch on", async () => {
    const daemon = fakeDaemon(false);

    const result = await grantAgentTools(daemon.paseo, deps());

    expect(result).toEqual({ injectIntoAgents: true, changed: true });
    expect(daemon.patches).toEqual([{ mcp: { injectIntoAgents: true } }]);
    expect(readSetupState(deps()).agentTools).toEqual({
      setBy: "plugin",
      previous: false,
      at: "2026-09-25T10:00:00.000Z",
    });
  });

  it("writes the record before the patch, not after", async () => {
    const daemon = fakeDaemon(false);
    const order: string[] = [];
    daemon.paseo.config.patch.mockImplementationOnce(async () => {
      // Whatever happens to the patch, the record is already on disk.
      order.push(readSetupState(deps()).agentTools === null ? "no record yet" : "record already written");
      daemon.state().mcp.injectIntoAgents = true;
      return {};
    });

    await grantAgentTools(daemon.paseo, deps());

    expect(order).toEqual(["record already written"]);
  });

  it("does nothing the second time", async () => {
    const daemon = fakeDaemon(false);
    await grantAgentTools(daemon.paseo, deps());
    const recorded = readSetupState(deps()).agentTools;

    const again = await grantAgentTools(daemon.paseo, deps());

    expect(again).toEqual({ injectIntoAgents: true, changed: false });
    expect(daemon.patches).toHaveLength(1);
    expect(readSetupState(deps()).agentTools).toEqual(recorded);
  });

  it("claims nothing when the user had already turned it on", async () => {
    const daemon = fakeDaemon(true);

    const result = await grantAgentTools(daemon.paseo, deps());

    expect(result).toEqual({ injectIntoAgents: true, changed: false });
    expect(daemon.patches).toEqual([]);
    // Nothing recorded: an undo must not turn off a switch paseo-bm never set.
    expect(readSetupState(deps()).agentTools).toBeNull();
  });

  it("puts the record back when the patch is refused", async () => {
    const daemon = fakeDaemon(false, { patchFails: true });
    updateSetupState({ agentTools: { setBy: "installer", previous: true, at: "2026-09-01T00:00:00.000Z" } }, deps());

    await expect(grantAgentTools(daemon.paseo, deps())).rejects.toMatchObject({ code: "E_SETUP_WRITE_FAILED" });

    expect(readSetupState(deps()).agentTools).toEqual({ setBy: "installer", previous: true, at: "2026-09-01T00:00:00.000Z" });
  });

  it("puts the record back when the daemon answers yes and keeps nothing", async () => {
    const daemon = fakeDaemon(false, { keepsIt: false });

    await expect(grantAgentTools(daemon.paseo, deps())).rejects.toMatchObject({ code: "E_SETUP_WRITE_FAILED" });

    expect(readSetupState(deps()).agentTools).toBeNull();
  });

  it("patches nothing when the record cannot be written", async () => {
    const daemon = fakeDaemon(false);
    mkdirSync(join(home, ".paseo-bm"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".paseo-bm", "ui"), "a file where the folder should be");

    await expect(grantAgentTools(daemon.paseo, deps())).rejects.toMatchObject({ code: "E_DATA_HOME_UNAVAILABLE" });

    expect(daemon.patches).toEqual([]);
    expect(daemon.state().mcp.injectIntoAgents).toBe(false);
  });
});

describe("the contract of setup.grant-agent-tools", () => {
  it("takes only an explicit confirmation", () => {
    expect(setupGrantAgentToolsRpc.input.parse({ confirmed: true })).toEqual({ confirmed: true });
    for (const input of [{}, { confirmed: false }, { confirmed: "true" }, { confirmed: 1 }]) {
      expect(() => setupGrantAgentToolsRpc.input.parse(input)).toThrow();
    }
  });

  it("only ever answers that the switch is on", () => {
    expect(() => setupGrantAgentToolsRpc.output.parse({ injectIntoAgents: false, changed: true })).toThrow();
    expect(setupGrantAgentToolsRpc.output.parse({ injectIntoAgents: true, changed: false })).toEqual({
      injectIntoAgents: true,
      changed: false,
    });
  });
});

// ── what setup.status reports about the machine (design §7.13.5) ───────────

describe("reading the sign-in state out of a provider diagnostic", () => {
  it("takes the boolean and nothing else", () => {
    expect(loginStateFromDiagnostic({ diagnostic: '{"loggedIn": true, "account": "someone@example.com"}' })).toBe("logged-in");
    expect(loginStateFromDiagnostic({ diagnostic: '{ "loggedIn" : false }' })).toBe("logged-out");
  });

  it("never guesses: anything without the boolean is unknown", () => {
    for (const value of [{ diagnostic: "the provider is fine" }, { diagnostic: 42 }, {}, null, "text", ["a"]]) {
      expect(loginStateFromDiagnostic(value)).toBe("unknown");
    }
  });
});

describe("providerLogins", () => {
  const config = {
    providers: {
      "bm-manager": { extends: "claude" },
      "bm-worker": { extends: "claude" },
      "bm-reviewer": { extends: "codex" },
    },
  };

  it("asks each distinct provider once and lists the roles that use it", async () => {
    const diagnostic = vi.fn(async (provider: string) => ({ diagnostic: `{"loggedIn": ${provider === "claude"}}` }));

    const logins = await providerLogins({ providers: { diagnostic } }, config);

    expect(diagnostic.mock.calls.map(([id]) => id)).toEqual(["claude", "codex"]);
    expect(logins).toEqual([
      { provider: "claude", roles: ["manager", "worker"], state: "logged-in", loginCommand: "claude auth login", guidance: null },
      { provider: "codex", roles: ["reviewer"], state: "logged-out", loginCommand: "codex login", guidance: null },
    ]);
  });

  it("returns the login command of each provider it knows, and Pi's guidance instead", async () => {
    const all = await providerLogins(
      {},
      {
        providers: {
          "bm-manager": { extends: "opencode" },
          "bm-worker": { extends: "pi" },
          "bm-reviewer": { extends: "something-else" },
        },
      },
    );

    expect(all.map((entry) => [entry.provider, entry.loginCommand, entry.guidance])).toEqual([
      ["opencode", "opencode providers login", null],
      ["pi", null, PI_SIGN_IN_GUIDANCE],
      ["something-else", null, null],
    ]);
    expect(PI_SIGN_IN_GUIDANCE).toBe(
      "Pi has no login command paseo-bm knows; sign in the way Pi's own documentation describes, then open Setup again.",
    );
  });

  it("says unknown when the call throws, and when there is no diagnostic at all", async () => {
    const throwing = await providerLogins({ providers: { diagnostic: async () => { throw new Error("no"); } } }, config);
    expect(throwing.map((entry) => entry.state)).toEqual(["unknown", "unknown"]);

    const absent = await providerLogins({}, config);
    expect(absent.map((entry) => entry.state)).toEqual(["unknown", "unknown"]);
  });

  it("says unknown rather than waiting for a provider that never answers", async () => {
    vi.useFakeTimers();
    try {
      const pending = providerLogins({ providers: { diagnostic: () => new Promise<never>(() => {}) } }, config);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await pending).map((entry) => entry.state)).toEqual(["unknown", "unknown"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns nothing for a machine whose roles have no provider yet", async () => {
    expect(await providerLogins({}, {})).toEqual([]);
  });
});

describe("installKind", () => {
  const fs = (files: Record<string, string>) => ({
    readFileSync: (path: string) => {
      const found = files[path];
      if (found === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return found;
    },
  });

  it("recognises a 0.3.x directory install by its layout and its install.json", () => {
    const record = fs({ "/Users/t/.paseo-bm/install.json": JSON.stringify({ schemaVersion: 1 }) });

    expect(installKind({ plugins: { "paseo-bm": { path: "/Users/t/.paseo-bm/plugin/0.3.1" } } }, record)).toEqual({
      kind: "installer-directory",
      pluginPath: "/Users/t/.paseo-bm/plugin/0.3.1",
    });
  });

  it("calls an npm install, a path of the wrong shape and no entry at all something else", () => {
    const npm = "/Users/t/.paseo/plugins/paseo-bm/abc/node_modules/paseo-bm-plugin";

    expect(installKind({ plugins: { "paseo-bm": { path: npm } } }, fs({})).kind).toBe("other");
    expect(installKind({ plugins: { "paseo-bm": { path: "relative" } } }, fs({})).kind).toBe("other");
    expect(installKind({ plugins: {} }, fs({}))).toEqual({ kind: "other", pluginPath: null });
    expect(installKind({}, fs({}))).toEqual({ kind: "other", pluginPath: null });
  });
});
