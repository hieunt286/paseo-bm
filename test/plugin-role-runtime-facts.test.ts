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
import { forgetModes } from "../plugin/server/role-mode";

/**
 * delta 20260917c §4.6, owner decision Q22: Paseo refuses a Worker created
 * without a mode before any hook runs (K10), so the Manager still passes one —
 * a concrete value the plugin writes into its instructions, instead of a
 * selection rule and an `inspect_provider` call.
 *
 * Errata 2026-09-18 (owner decision Q1a of req-20260918T035101Z): Paseo refuses
 * a Reviewer that a `bypassPermissions` Worker creates without a mode too, so
 * the Worker gets the same kind of line for its Reviewer.
 */

const LINE = "Worker mode: `bypassPermissions` — pass it as `settings.modeId` when you create a Worker.";
const REVIEWER_LINE = "Reviewer mode: `auto` — pass it as `settings.modeId` when you create a Reviewer.";

describe("runtimeFactsText", () => {
  it("states the Worker mode for the Manager, word for word", () => {
    expect(runtimeFactsText("manager", { workerModeId: "bypassPermissions" })).toBe(`${RUNTIME_FACTS_HEADING}\n\n${LINE}`);
  });

  it("states the Reviewer mode for the Worker, word for word", () => {
    expect(runtimeFactsText("worker", { reviewerModeId: "auto" })).toBe(`${RUNTIME_FACTS_HEADING}\n\n${REVIEWER_LINE}`);
  });

  it("says nothing without a mode, or for the other roles", () => {
    expect(runtimeFactsText("manager", {})).toBe("");
    expect(runtimeFactsText("manager", { workerModeId: "  " })).toBe("");
    expect(runtimeFactsText("manager", { workerModeId: null })).toBe("");
    expect(runtimeFactsText("manager", { reviewerModeId: "auto" })).toBe("");
    expect(runtimeFactsText("worker", {})).toBe("");
    expect(runtimeFactsText("worker", { reviewerModeId: "  " })).toBe("");
    expect(runtimeFactsText("worker", { reviewerModeId: null })).toBe("");
    expect(runtimeFactsText("worker", { workerModeId: "bypassPermissions" })).toBe("");
    expect(runtimeFactsText("reviewer", { workerModeId: "bypassPermissions" })).toBe("");
    expect(runtimeFactsText("reviewer", { reviewerModeId: "auto" })).toBe("");
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

  it("puts the Worker's Reviewer mode after its role text and before the user's additions", () => {
    expect(fullInstructions("worker", "Be brief.", { reviewerModeId: "auto" })).toBe(
      `${BASE_INSTRUCTIONS.worker.trimEnd()}\n\n${RUNTIME_FACTS_HEADING}\n\n${REVIEWER_LINE}\n\n---\n\n${EXTRA_HEADING}\n\nBe brief.\n`,
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

  it("looks nothing up for the Reviewer", async () => {
    const api = paseo(async () => ({ modes: [] }));
    expect(await runtimeFactsOf("reviewer", api)).toEqual({});
    expect(api.providers.listModes).not.toHaveBeenCalled();
  });

  const CODEX = [
    { id: "auto", colorTier: "moderate" },
    { id: "auto-review", colorTier: "moderate" },
    { id: "full-access", colorTier: "dangerous" },
  ];
  const CLAUDE = [
    { id: "plan", colorTier: "planning" },
    { id: "default", colorTier: "safe" },
    { id: "acceptEdits", colorTier: "moderate" },
    { id: "auto", colorTier: "moderate" },
    { id: "bypassPermissions", colorTier: "dangerous" },
  ];
  const withProfile = (api: object, modeId: string) => ({
    ...api,
    config: { get: async () => ({ config: { agentProfiles: [{ id: "bm-reviewer", modeId }] } }) },
  });

  it("picks the Reviewer mode for the Worker with the hook's Reviewer rule, from the bm-reviewer list", async () => {
    const codex = paseo(async () => ({ modes: CODEX }));
    expect(await runtimeFactsOf("worker", codex)).toEqual({ reviewerModeId: "auto" });
    expect(codex.providers.listModes).toHaveBeenCalledWith("bm-reviewer");
    expect(codex.providers.listModes).not.toHaveBeenCalledWith("bm-worker");
    expect(await runtimeFactsOf("worker", paseo(async () => ({ modes: CLAUDE })))).toEqual({ reviewerModeId: "auto" });
  });

  it("lets a safe mode set by hand on the bm-reviewer profile win, but never a dangerous one", async () => {
    expect(await runtimeFactsOf("worker", withProfile(paseo(async () => ({ modes: CLAUDE })), "default"))).toEqual({
      reviewerModeId: "default",
    });
    expect(await runtimeFactsOf("worker", withProfile(paseo(async () => ({ modes: CODEX })), "full-access"))).toEqual({
      reviewerModeId: "auto",
    });
  });

  it("gives the Worker the static fallback `auto`, never the profile's dangerous mode, when no bm-reviewer list was ever read", async () => {
    // Before delta 20260918g this gave no line at all, and the Worker's first
    // Reviewer creation was refused (owner decisions Q4 a, Q9 a).
    forgetModes();
    const log = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unreadable = withProfile(paseo(async () => { throw new Error("daemon busy"); }), "full-access");
    expect(await runtimeFactsOf("worker", unreadable, undefined, log)).toEqual({ reviewerModeId: "auto" });
    expect(await runtimeFactsOf("worker", {}, undefined, log)).toEqual({ reviewerModeId: "auto" });
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      '[paseo-bm] could not read the modes of bm-reviewer; the Worker is told to pass the fallback Reviewer mode "auto" (static fallback).',
      '[paseo-bm] could not read the modes of bm-reviewer; the Worker is told to pass the fallback Reviewer mode "auto" (static fallback).',
    ]);
    // modesFor still logs each failed lookup itself.
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("falls back on the last bm-reviewer list read in this run, through the same rule", async () => {
    forgetModes();
    const listed = paseo(async () => ({ modes: [{ id: "default", colorTier: "safe" }, { id: "yolo", colorTier: "dangerous" }] }));
    expect(await runtimeFactsOf("worker", listed)).toEqual({ reviewerModeId: "default" });
    const log = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await runtimeFactsOf("worker", paseo(async () => { throw new Error("daemon busy"); }), undefined, log)).toEqual({ reviewerModeId: "default" });
    expect(String(log.mock.calls[0]![0])).toMatch(/^\[paseo-bm\] could not read the modes of bm-reviewer; the Worker is told to pass the fallback Reviewer mode "default" \(last list read at \d{4}-\d{2}-\d{2}T/);
    warn.mockRestore();
  });

  it("logs an unexpected failure instead of swallowing it", async () => {
    const log = vi.fn();
    const hostile = {
      get providers(): never {
        throw new Error("host exploded");
      },
    };
    expect(await runtimeFactsOf("worker", hostile, undefined, log)).toEqual({});
    expect(log).toHaveBeenCalledWith("[paseo-bm] reading the Runtime facts of worker failed: host exploded");
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

  it("adds the Reviewer mode to the Worker and never adds facts to the Reviewer", async () => {
    const api = { providers: { listModes: async () => ({ modes: [{ id: "full-access", colorTier: "dangerous" }, { id: "auto", colorTier: "moderate" }] }) } };
    const worker = await currentInstructions("worker", api, { homedir: () => "/nonexistent-home-for-test" });
    expect(worker).toBe(fullInstructions("worker", "", { reviewerModeId: "auto" }));
    expect(worker).toContain("Reviewer mode: `auto`");
    expect(await currentInstructions("reviewer", api, { homedir: () => "/nonexistent-home-for-test" })).toBe(BASE_INSTRUCTIONS.reviewer);
  });
});

describe("Runtime facts by provider capability (delta 20260921 §4.2.3, REQ-063 c)", () => {
  const paseo = (listModes: (provider: string) => unknown, providers?: Record<string, unknown>, profiles: unknown[] = []) => ({
    providers: { listModes: vi.fn(listModes) },
    ...(providers === undefined ? {} : { config: { get: async () => ({ config: { providers, agentProfiles: profiles } }) } }),
  });
  const OPENCODE = [{ id: "bytes" }, { id: "review" }];

  it("says 'none' for a child whose provider has no modes, word for word", () => {
    expect(runtimeFactsText("manager", { workerModeNone: true })).toBe(
      `${RUNTIME_FACTS_HEADING}\n\nWorker mode: none — do not pass \`settings.modeId\` when you create a Worker; Paseo sets it.`,
    );
    expect(runtimeFactsText("worker", { reviewerModeNone: true })).toBe(
      `${RUNTIME_FACTS_HEADING}\n\nReviewer mode: none — do not pass \`settings.modeId\` when you create a Reviewer; Paseo sets it.`,
    );
    expect(runtimeFactsText("reviewer", { reviewerModeNone: true })).toBe("");
  });

  it("names none for a Pi Worker or Reviewer", async () => {
    expect(await runtimeFactsOf("manager", paseo(async () => ({ modes: [] })))).toEqual({ workerModeNone: true });
    expect(await runtimeFactsOf("worker", paseo(async () => ({ modes: [] })))).toEqual({ reviewerModeNone: true });
  });

  it("names the OpenCode agent the hook would pass: the profile's if listed, else the first", async () => {
    expect(await runtimeFactsOf("manager", paseo(async () => ({ modes: OPENCODE })))).toEqual({ workerModeId: "bytes" });
    expect(await runtimeFactsOf("worker", paseo(async () => ({ modes: OPENCODE }), {}, [{ id: "bm-reviewer", modeId: "review" }]))).toEqual({
      reviewerModeId: "review",
    });
  });

  it("tells the fallback `auto` only when bm-reviewer runs on Claude or Codex (or its base cannot be read)", async () => {
    forgetModes();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = async () => {
      throw new Error("daemon busy");
    };
    const log = vi.fn();
    expect(await runtimeFactsOf("worker", paseo(failing, { "bm-reviewer": { extends: "codex" } }), undefined, log)).toEqual({ reviewerModeId: "auto" });
    expect(await runtimeFactsOf("worker", paseo(failing, { "bm-reviewer": { extends: "opencode" } }), undefined, log)).toEqual({});
    expect(log.mock.calls.at(-1)?.[0]).toBe("[paseo-bm] could not read the modes of bm-reviewer (base provider opencode); the Worker is told no Reviewer mode.");
    warn.mockRestore();
  });

  it("tells the creators, in their role files, to pass exactly that value and nothing for 'none'", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (name: string) => readFileSync(new URL(`../plugin/roles/${name}.md`, import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(read("manager")).toContain("when it says `none`, pass no `settings.modeId`");
    expect(read("worker")).toContain("Runtime facts` (`none`: pass no mode;");
  });
});
