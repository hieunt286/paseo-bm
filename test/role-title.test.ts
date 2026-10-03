import { describe, expect, it } from "vitest";
import { ROLE_TITLE_MARKERS, applyRoleTitle, withRoleMarker } from "../plugin/server/role-title";

describe("role marker in the agent title (owner choice 2026-10-01)", () => {
  it("has one marker per role: a colour dot and the role's initial", () => {
    expect(ROLE_TITLE_MARKERS).toEqual({ manager: "🟣 M", worker: "🔵 W", reviewer: "🟠 R", orchestrator: "🟢 O" });
  });

  it("puts the marker in front of the title once", () => {
    expect(withRoleMarker("manager", "Beads Manager")).toBe("🟣 M · Beads Manager");
    expect(withRoleMarker("manager", "🟣 M · Beads Manager")).toBe("🟣 M · Beads Manager");
  });

  it("marks every paseo-bm provider, fallback aliases and <id>/<model> included", () => {
    expect(applyRoleTitle({ config: { provider: "bm-worker/gpt-5.6-sol", title: "Fix login" } })?.config.title).toBe("🔵 W · Fix login");
    expect(applyRoleTitle({ config: { provider: "bm-reviewer", title: "Review" } })?.config.title).toBe("🟠 R · Review");
    expect(applyRoleTitle({ config: { provider: "bm-orchestrator", title: "Beads Orchestrator" } })?.config.title).toBe("🟢 O · Beads Orchestrator");
    expect(applyRoleTitle({ config: { provider: "bm-worker-fallback-1/qwen3-coder", title: "Beads Worker (fallback)" } })?.config.title).toBe(
      "🔵 W · Beads Worker (fallback)",
    );
  });

  it("changes nothing for another provider, a missing or blank title, a marked title or a malformed request", () => {
    expect(applyRoleTitle({ config: { provider: "claude/opus", title: "Mine" } })).toBeUndefined();
    expect(applyRoleTitle({ config: { provider: "bm-worker" } })).toBeUndefined();
    expect(applyRoleTitle({ config: { provider: "bm-worker", title: "  " } })).toBeUndefined();
    expect(applyRoleTitle({ config: { provider: "bm-worker", title: "🔵 W · Fix login" } })).toBeUndefined();
    expect(applyRoleTitle(null as never)).toBeUndefined();
  });

  it("keeps the rest of the request", () => {
    const request = { config: { provider: "bm-manager", title: "Beads Manager", cwd: "/repo" }, env: { A: "1" } };
    expect(applyRoleTitle(request)).toEqual({ config: { ...request.config, title: "🟣 M · Beads Manager" }, env: { A: "1" } });
    expect(request.config.title).toBe("Beads Manager");
  });
});

describe("withoutRoleMarker", () => {
  it("takes a role marker off the front, and leaves anything else as it is", async () => {
    const { withoutRoleMarker } = await import("../plugin/server/role-title");
    expect(withoutRoleMarker("🟣 M · Beads Manager")).toBe("Beads Manager");
    expect(withoutRoleMarker("🔵 W · Fix login")).toBe("Fix login");
    expect(withoutRoleMarker("Fix 🔵 W · login")).toBe("Fix 🔵 W · login");
    expect(withoutRoleMarker(null)).toBeNull();
    expect(withoutRoleMarker(undefined)).toBeUndefined();
  });
});

describe("createTitleMarker: a title Paseo set after the creation (a cleared conversation)", () => {
  async function setup(title: string | null, cliCode = 0) {
    const { createTitleMarker } = await import("../plugin/server/role-title");
    const calls: string[][] = [];
    const refreshes: string[] = [];
    const logs: string[] = [];
    const marker = createTitleMarker({
      cli: { find: () => "/bin/paseo", run: async (_file, args) => (calls.push(args), { code: cliCode, output: "", timedOut: false }) },
      log: (message) => logs.push(message),
    });
    const paseo = { agents: { ref: (id: string) => ({ refresh: async () => (refreshes.push(id), { agent: { title } }) }) } };
    return { marker, paseo, calls, refreshes, logs };
  }

  it("puts the marker back on the name Paseo gave the agent, once", async () => {
    const { marker, paseo, calls } = await setup("Project còn nhiều bead chưa xong");
    expect(await marker.remark({ id: "a1", provider: "bm-manager", title: null }, paseo)).toBe("marked");
    expect(calls).toEqual([["agent", "update", "a1", "--name", "🟣 M · Project còn nhiều bead chưa xong", "--json"]]);
    expect(await marker.remark({ id: "a1", provider: "bm-manager", title: null }, paseo)).toBe("already-marked");
    expect(calls).toHaveLength(1);
  });

  it("swaps another role's marker for the agent's own", async () => {
    const { marker, paseo, calls } = await setup("🟣 M · Fix login");
    expect(await marker.remark({ id: "w1", provider: "bm-worker/gpt-5.6-sol", title: null }, paseo)).toBe("marked");
    expect(calls[0]?.[4]).toBe("🔵 W · Fix login");
  });

  it("reads nothing for an agent whose event title is already marked, or another provider", async () => {
    const { marker, paseo, calls, refreshes } = await setup("x");
    expect(await marker.remark({ id: "a1", provider: "bm-worker", title: "🔵 W · Fix" }, paseo)).toBe("already-marked");
    expect(await marker.remark({ id: "a2", provider: "claude", title: null }, paseo)).toBe("not-bm");
    expect(refreshes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("leaves an agent with no title yet, or already marked, without a command", async () => {
    const empty = await setup(null);
    expect(await empty.marker.remark({ id: "a1", provider: "bm-worker", title: null }, empty.paseo)).toBe("no-title");
    expect(empty.calls).toEqual([]);
    const marked = await setup("🔵 W · Fix");
    expect(await marked.marker.remark({ id: "a1", provider: "bm-worker", title: null }, marked.paseo)).toBe("already-marked");
    expect(marked.calls).toEqual([]);
  });

  it("logs a failed command and tries again at the next turn", async () => {
    const { marker, paseo, calls, logs } = await setup("Fix", 1);
    expect(await marker.remark({ id: "a1", provider: "bm-worker", title: null }, paseo)).toBe("failed");
    expect(logs[0]).toContain("could not mark the title of a1");
    expect(await marker.remark({ id: "a1", provider: "bm-worker", title: null }, paseo)).toBe("failed");
    expect(calls).toHaveLength(2);
  });
});
