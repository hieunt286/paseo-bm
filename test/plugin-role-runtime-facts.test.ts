import { describe, expect, it, vi } from "vitest";
import {
  BASE_INSTRUCTIONS,
  EXTRA_HEADING,
  RUNTIME_FACTS_HEADING,
  currentInstructions,
  fullInstructions,
  runtimeFactsOf,
  runtimeFactsText,
} from "../plugin/server/role-extras";

/**
 * delta 20260917c §4.6, owner decision Q22: Paseo refuses a Worker created
 * without a mode before any hook runs (K10), so the Manager still passes one —
 * a concrete value the plugin writes into its instructions, instead of a
 * selection rule and an `inspect_provider` call.
 */

const LINE = "Worker mode: `bypassPermissions` — pass it as `settings.modeId` when you create a Worker.";

describe("runtimeFactsText", () => {
  it("states the Worker mode for the Manager, word for word", () => {
    expect(runtimeFactsText("manager", { workerModeId: "bypassPermissions" })).toBe(`${RUNTIME_FACTS_HEADING}\n\n${LINE}`);
  });

  it("says nothing without a mode, or for the other roles", () => {
    expect(runtimeFactsText("manager", {})).toBe("");
    expect(runtimeFactsText("manager", { workerModeId: "  " })).toBe("");
    expect(runtimeFactsText("manager", { workerModeId: null })).toBe("");
    expect(runtimeFactsText("worker", { workerModeId: "bypassPermissions" })).toBe("");
    expect(runtimeFactsText("reviewer", { workerModeId: "bypassPermissions" })).toBe("");
  });
});

describe("fullInstructions with Runtime facts", () => {
  const base = BASE_INSTRUCTIONS.manager;

  it("is the base, byte for byte, with neither facts nor extras", () => {
    expect(fullInstructions("manager", "", {})).toBe(base);
    expect(fullInstructions("manager", "   ")).toBe(base);
  });

  it("puts the facts after the role text", () => {
    expect(fullInstructions("manager", "", { workerModeId: "bypassPermissions" })).toBe(
      `${base.trimEnd()}\n\n${RUNTIME_FACTS_HEADING}\n\n${LINE}\n`,
    );
  });

  it("puts the user's additions after the facts, under their own heading", () => {
    const text = fullInstructions("manager", "Answer in Vietnamese.", { workerModeId: "bypassPermissions" });
    expect(text).toBe(
      `${base.trimEnd()}\n\n${RUNTIME_FACTS_HEADING}\n\n${LINE}\n\n---\n\n${EXTRA_HEADING}\n\nAnswer in Vietnamese.\n`,
    );
  });

  it("keeps the old shape for the user's additions when there are no facts", () => {
    expect(fullInstructions("worker", "Be brief.")).toBe(
      `${BASE_INSTRUCTIONS.worker.trimEnd()}\n\n---\n\n${EXTRA_HEADING}\n\nBe brief.\n`,
    );
  });
});

describe("runtimeFactsOf", () => {
  const paseo = (listModes: (provider: string) => unknown) => ({ providers: { listModes: vi.fn(listModes) } });

  it("picks the Worker mode with the hook's own rule, from the bm-worker list", async () => {
    const api = paseo(async () => ({
      modes: [
        { id: "plan", colorTier: "planning" },
        { id: "default", colorTier: "safe" },
        { id: "bypassPermissions", colorTier: "dangerous" },
      ],
    }));
    expect(await runtimeFactsOf("manager", api)).toEqual({ workerModeId: "bypassPermissions" });
    expect(api.providers.listModes).toHaveBeenCalledWith("bm-worker");
  });

  it("looks nothing up for the Worker or the Reviewer", async () => {
    const api = paseo(async () => ({ modes: [] }));
    expect(await runtimeFactsOf("worker", api)).toEqual({});
    expect(await runtimeFactsOf("reviewer", api)).toEqual({});
    expect(api.providers.listModes).not.toHaveBeenCalled();
  });

  it("returns no facts, and logs, when the modes cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runtimeFactsOf("manager", paseo(async () => { throw new Error("daemon busy"); }))).toEqual({});
    expect(await runtimeFactsOf("manager", {})).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("currentInstructions (the manager.ensure path)", () => {
  it("writes the same Runtime facts the agent.create hook would", async () => {
    const api = {
      providers: { listModes: async () => ({ modes: [{ id: "full-access", colorTier: "dangerous" }, { id: "auto", colorTier: "moderate" }] }) },
    };
    const text = await currentInstructions("manager", api, { homedir: () => "/nonexistent-home-for-test" });
    expect(text).toBe(fullInstructions("manager", "", { workerModeId: "full-access" }));
    expect(text).toContain("Worker mode: `full-access`");
  });

  it("never adds facts to the Worker or the Reviewer", async () => {
    const api = { providers: { listModes: async () => ({ modes: [{ id: "x", colorTier: "dangerous" }] }) } };
    expect(await currentInstructions("worker", api, { homedir: () => "/nonexistent-home-for-test" })).toBe(BASE_INSTRUCTIONS.worker);
  });
});
