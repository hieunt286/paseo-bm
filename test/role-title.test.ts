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
