import { describe, expect, it } from "vitest";
import { isReachable, presenceOf } from "../plugin/server/agent-presence";

/** ADR-042: Paseo's idle collection leaves an agent resting, never gone. */
const SESSION = { sessionId: "session-1" };

describe("presenceOf", () => {
  it.each([
    ["no snapshot", null, "gone"],
    ["an archived agent, even with a session", { status: "closed", archivedAt: "2026-11-06T00:00:00.000Z", persistence: SESSION }, "gone"],
    ["a closed agent with no session", { status: "closed", persistence: null }, "gone"],
    ["a closed agent whose snapshot carries no session", { status: "closed" }, "gone"],
    ["a closed agent with an empty session", { status: "closed", persistence: { sessionId: " " } }, "gone"],
    ["a closed agent with a session", { status: "closed", archivedAt: null, persistence: SESSION }, "resting"],
    ["an idle agent", { status: "idle" }, "live"],
    ["a running agent", { status: "running" }, "live"],
  ])("reads %s", (_name, agent, presence) => {
    expect(presenceOf(agent)).toBe(presence);
  });
});

describe("isReachable", () => {
  it("is true for a live or a resting agent, false for an archived or a closed one", () => {
    expect(isReachable({ status: "idle", archived: false })).toBe(true);
    expect(isReachable({ status: "closed", archived: false, resting: true })).toBe(true);
    expect(isReachable({ status: "closed", archived: false })).toBe(false);
    expect(isReachable({ status: "idle", archived: true })).toBe(false);
  });
});
