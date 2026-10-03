import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_BOUNDARY_KEY,
  BASE_INSTRUCTIONS,
  MAX_INJECTED_PRECEDENTS,
  OWNER_PRECEDENTS_HEADING,
  RUNTIME_FACTS_HEADING,
  currentInstructions,
  fullInstructions,
  precedentFactsOf,
  precedentLine,
  reviewBudgetLine,
  actionBoundaryLine,
  actionBoundaryOfPrompt,
  creationProjectOf,
  runtimeFactsOf,
  runtimeFactsText,
} from "../plugin/server/role-instructions";
import { createAutonomyStore } from "../plugin/server/autonomy-store";
import { createCoordinationStore } from "../plugin/server/coordination-store";
import { forgetModes } from "../plugin/server/role-mode";
import { currentInstructionsHash, instructionsHashOf, roleTextOf } from "../plugin/server/instructions-label";
import { PRECEDENT_SCOPE_ALL, type Precedent } from "../plugin/shared/precedents";

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
const DEFAULT_BUDGET = { Small: 2, Medium: 2, Large: 4 };
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

  it("is the base, byte for byte, with no facts", () => {
    expect(fullInstructions("manager", {})).toBe(base);
    expect(fullInstructions("manager")).toBe(base);
  });

  it("puts the facts after the role text", () => {
    expect(fullInstructions("manager", { workerModeId: "bypassPermissions" })).toBe(
      `${base.trimEnd()}\n\n${RUNTIME_FACTS_HEADING}\n\n${LINE}\n`,
    );
  });

  it("puts the Worker's Reviewer mode after its role text, and ends there: nothing the owner writes is appended (autonomy design §B.8)", () => {
    const text = fullInstructions("worker", { reviewerModeId: "auto" });
    expect(text).toBe(`${BASE_INSTRUCTIONS.worker.trimEnd()}\n\n${RUNTIME_FACTS_HEADING}\n\n${REVIEWER_LINE}\n`);
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
    expect(text).toBe(fullInstructions("manager", { workerModeId: "full-access" }));
    expect(text).toContain("Worker mode: `full-access`");
  });

  it("adds the Reviewer mode to the Worker and never adds facts to the Reviewer", async () => {
    const api = { providers: { listModes: async () => ({ modes: [{ id: "full-access", colorTier: "dangerous" }, { id: "auto", colorTier: "moderate" }] }) } };
    const worker = await currentInstructions("worker", api, { homedir: () => "/nonexistent-home-for-test" });
    // With no data folder the review budget reads its defaults (bead 7gxw.12).
    expect(worker).toBe(fullInstructions("worker", { reviewerModeId: "auto", reviewBudget: DEFAULT_BUDGET }));
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

  it("tells the creators, in their role files, to pass exactly what the Runtime facts say — whose 'none' line says to pass nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (name: string) => readFileSync(new URL(`../plugin/roles/${name}.md`, import.meta.url), "utf8").replace(/\s+/g, " ");
    // Bead 81y2.24: the role files no longer repeat the 'none' rule; the fact line itself says it (pinned word for word above).
    expect(read("manager")).toContain("`settings.modeId` exactly as your `## Runtime facts` say");
    expect(read("worker")).toContain("`settings.modeId` exactly as your `## Runtime facts` say");
    expect(runtimeFactsText("manager", { workerModeNone: true })).toContain("do not pass `settings.modeId`");
    expect(runtimeFactsText("worker", { reviewerModeNone: true })).toContain("do not pass `settings.modeId`");
  });
});

/**
 * The Manager's `Worker skills` line (design delta 20260924-instruction-quality
 * §3, PRD delta 20260924-worker-autonomy REQ-035a): the plugin checks the
 * required skills for the provider `bm-worker` extends, instead of the Manager
 * reading skill directories itself.
 */
describe("Worker skills in the Manager's Runtime facts", () => {
  const status = (missingForCodex: string[]) => () => ({
    checkedAt: "",
    dirs: { shared: "", claude: "", codex: "", pi: "", opencode: "" },
    skills: ["feature-workflow", "polishing-beads", "architecture-premise-audit"].map((name) => ({
      name,
      required: name !== "architecture-premise-audit",
      claude: "ok" as const,
      codex: missingForCodex.includes(name) ? ("missing" as const) : ("ok" as const),
      pi: "missing" as const,
      opencode: "missing" as const,
      problem: null,
    })),
    missingRequired: { claude: 0, codex: 0, pi: 0, opencode: 0 },
    installCommand: "",
  });
  const paseoExtending = (base: string | null) => ({
    providers: { listModes: vi.fn(async () => { throw new Error("no modes here"); }) },
    config: { get: async () => ({ config: { providers: base === null ? {} : { "bm-worker": { extends: base } } } }) },
  });

  it("names the required skills the Worker's provider lacks, and only required ones", async () => {
    const facts = await runtimeFactsOf("manager", paseoExtending("codex"), "/repo", () => {}, status(["polishing-beads", "architecture-premise-audit"]));
    expect(facts.workerSkillsMissing).toEqual(["polishing-beads"]);
    expect(runtimeFactsText("manager", facts)).toBe(
      `${RUNTIME_FACTS_HEADING}\n\nWorker skills: missing \`polishing-beads\` — tell the user once, when you confirm the Worker, that it works with lower quality, and point to Beads Manager → Tools & skills.`,
    );
  });

  it("says all present, and sits after the mode line", async () => {
    const facts = await runtimeFactsOf("manager", paseoExtending("claude"), "/repo", () => {}, status(["polishing-beads"]));
    expect(facts.workerSkillsMissing).toEqual([]);
    expect(runtimeFactsText("manager", { workerModeId: "bypassPermissions", workerSkillsMissing: [] })).toBe(
      `${RUNTIME_FACTS_HEADING}\n\n${LINE}\nWorker skills: all present.`,
    );
  });

  it("writes no line when the provider or the skills cannot be read, and never throws", async () => {
    expect((await runtimeFactsOf("manager", paseoExtending(null), "/repo", () => {}, status([]))).workerSkillsMissing).toBeUndefined();
    const log: string[] = [];
    const broken = () => {
      throw new Error("EACCES");
    };
    expect((await runtimeFactsOf("manager", paseoExtending("codex"), "/repo", (m) => log.push(m), broken)).workerSkillsMissing).toBeUndefined();
    expect(log.join("\n")).toContain("checking the Worker's skills failed");
    // The Worker and the Reviewer never get the line.
    expect(runtimeFactsText("worker", { workerSkillsMissing: ["x"] })).toBe("");
  });
});

describe("## Owner precedents (autonomy design §B.6, §B.9; PRD REQ-124 b, REQ-117 c)", () => {
  const precedent = (id: string, overrides: Partial<Precedent> = {}): Precedent => ({
    id: `p:${id}`,
    scope: "ws-1",
    subject: `subject-${id}`,
    text: `Answer ${id}.`,
    sourceDecisionId: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    expiresAt: "2099-10-20T10:00:00.000Z",
    supersededBy: null,
    ...overrides,
  });
  const fact = ({ subject, text, scope, expiresAt }: Precedent) => ({ subject, text, scope, expiresAt });
  const noModes = {};
  // The host below lists no modes: its one log line per lookup is not what these tests read.
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes one line per precedent — subject, text, where, until — after the Runtime facts", () => {
    const facts = {
      workerModeId: "bypassPermissions",
      precedents: [fact(precedent("a", { subject: "user-list-storage", text: "The existing users table." })), fact(precedent("b", { scope: PRECEDENT_SCOPE_ALL }))],
    };
    expect(runtimeFactsText("manager", facts)).toBe(
      `${RUNTIME_FACTS_HEADING}\n\n${LINE}\n\n${OWNER_PRECEDENTS_HEADING}\n\n` +
        "- `user-list-storage` — The existing users table. (this project, until 2099-10-20)\n" +
        "- `subject-b` — Answer b. (all projects, until 2099-10-20)",
    );
  });

  it("stands alone without other facts, keeps a text on one line, and names no heading when there are none", () => {
    const multiline = fact(precedent("m", { text: "Use pnpm.\n\n  Never npm." }));
    expect(runtimeFactsText("worker", { precedents: [multiline] })).toBe(
      `${OWNER_PRECEDENTS_HEADING}\n\n- \`subject-m\` — Use pnpm. Never npm. (this project, until 2099-10-20)`,
    );
    expect(precedentLine(multiline)).not.toContain("\n");
    expect(runtimeFactsText("worker", { precedents: [] })).toBe("");
    expect(runtimeFactsText("worker", { reviewerModeId: "auto", precedents: [] })).toBe(`${RUNTIME_FACTS_HEADING}\n\n${REVIEWER_LINE}`);
  });

  it("gives them only to the Manager and the Worker, at most 20", () => {
    const many = Array.from({ length: 25 }, (_, i) => fact(precedent(String(i))));
    expect(runtimeFactsText("reviewer", { precedents: many })).toBe("");
    expect(runtimeFactsText("orchestrator", { precedents: many })).toBe("");
    const text = runtimeFactsText("worker", { precedents: many });
    expect(text.split("\n").filter((line) => line.startsWith("- `"))).toHaveLength(MAX_INJECTED_PRECEDENTS);
    expect(MAX_INJECTED_PRECEDENTS).toBe(20);
    expect(text).toContain("`subject-19`");
    expect(text).not.toContain("`subject-20`");
  });

  it("puts them after the role text, and keeps the role text whole: the bm.instructions label stays the role file's", () => {
    const text = fullInstructions("worker", { precedents: [fact(precedent("a"))] });
    expect(text).toBe(
      `${BASE_INSTRUCTIONS.worker.trimEnd()}\n\n${OWNER_PRECEDENTS_HEADING}\n\n- \`subject-a\` — Answer a. (this project, until 2099-10-20)\n`,
    );
    // agent-labels.ts labels an agent whose prompt holds its role text; the label is that text's hash.
    expect(text).toContain(roleTextOf("worker"));
    expect(currentInstructionsHash("worker")).toBe(instructionsHashOf(BASE_INSTRUCTIONS.worker));
  });

  it("reads the workspace's and the global ones, never another project's, newest 20", async () => {
    const stored = [
      precedent("global", { scope: PRECEDENT_SCOPE_ALL, createdAt: "2026-09-25T10:00:00.000Z" }),
      precedent("mine", { createdAt: "2026-09-26T10:00:00.000Z" }),
      precedent("theirs", { scope: "ws-2", createdAt: "2026-09-27T10:00:00.000Z" }),
    ];
    const read = vi.fn((workspaceId: string | undefined) => stored.filter((p) => workspaceId === undefined || p.scope === workspaceId || p.scope === PRECEDENT_SCOPE_ALL));
    const workspaceOf = vi.fn(async () => "ws-1");
    const facts = await runtimeFactsOf("worker", noModes, "/repo", () => {}, undefined, { workspaceOf, read });
    expect(workspaceOf).toHaveBeenCalledWith("/repo");
    expect(read).toHaveBeenCalledWith("ws-1");
    expect(facts.precedents).toEqual([fact(stored[0]!), fact(stored[1]!)]);

    const many = Array.from({ length: 30 }, (_, i) => precedent(`n${i}`));
    const capped = await precedentFactsOf("manager", undefined, { workspaceId: "ws-1", read: () => many });
    expect(capped.precedents?.map((p) => p.subject)).toEqual(many.slice(0, 20).map((p) => p.subject));
  });

  it("injects only the global ones when the workspace cannot be told, and nothing when the read fails", async () => {
    const stored = [precedent("global", { scope: PRECEDENT_SCOPE_ALL }), precedent("mine"), precedent("theirs", { scope: "ws-2" })];
    const read = () => stored;
    for (const workspaceOf of [async () => null, async () => { throw new Error("daemon busy"); }, () => { throw new Error("sync"); }]) {
      const facts = await precedentFactsOf("worker", "/repo", { workspaceOf: workspaceOf as () => Promise<string | null>, read });
      expect(facts.precedents?.map((p) => p.subject)).toEqual(["subject-global"]);
    }
    expect((await precedentFactsOf("worker", undefined, { read })).precedents?.map((p) => p.subject)).toEqual(["subject-global"]);

    const log = vi.fn();
    const broken = () => {
      throw new Error("EACCES");
    };
    expect(await runtimeFactsOf("worker", noModes, "/repo", log, undefined, { workspaceId: "ws-1", read: broken, reviewBudget: () => DEFAULT_BUDGET })).toEqual({
      reviewerModeId: "auto",
      reviewBudget: DEFAULT_BUDGET,
    });
    expect(log).toHaveBeenCalledWith("[paseo-bm] reading the owner's precedents for a new worker failed: EACCES");
  });

  it("never reads them for the Reviewer or the Orchestrator, nor without a lookup", async () => {
    const read = vi.fn(() => [precedent("a")]);
    expect(await precedentFactsOf("reviewer", "/repo", { workspaceId: "ws-1", read })).toEqual({});
    expect(await precedentFactsOf("orchestrator", "/repo", { workspaceId: "ws-1", read })).toEqual({});
    expect(read).not.toHaveBeenCalled();
    expect((await runtimeFactsOf("manager", noModes, "/repo", () => {})).precedents).toBeUndefined();
  });

  it("gives a Manager created by manager.ensure the precedents of its workspace, from the data folder, expired and superseded left out", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-precedent-facts-"));
    try {
      const dir = join(root, ".paseo-bm", "autonomy");
      mkdirSync(dir, { recursive: true });
      const entries = [
        precedent("global", { scope: PRECEDENT_SCOPE_ALL, createdAt: "2026-09-21T10:00:00.000Z" }),
        precedent("mine", { createdAt: "2026-09-22T10:00:00.000Z" }),
        precedent("theirs", { scope: "ws-2" }),
        precedent("expired", { expiresAt: "2000-01-01T00:00:00.000Z" }),
        precedent("superseded", { supersededBy: "p:mine" }),
      ];
      writeFileSync(join(dir, "precedents.json"), JSON.stringify({ version: 1, entries }));
      const text = await currentInstructions("manager", {}, { homedir: () => root, workspaceId: "ws-1" });
      const globalOnly = await currentInstructions("manager", {}, { homedir: () => root });
      expect(text).toBe(fullInstructions("manager", { precedents: [fact(entries[1]!), fact(entries[0]!)] }));
      expect(text).toContain(`${OWNER_PRECEDENTS_HEADING}\n\n- \`subject-mine\` — Answer mine. (this project, until 2099-10-20)\n- \`subject-global\``);
      for (const other of ["subject-theirs", "subject-expired", "subject-superseded"]) expect(text).not.toContain(other);
      expect(globalOnly).toBe(fullInstructions("manager", { precedents: [fact(entries[0]!)] }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Bead 7gxw.12 (autonomy design §C.4, §G.7; change-008 C6): the review budget per tier is the owner's setting, and a
// new Worker is told it in its Runtime facts; worker.md's budget line points there.
describe("the review budget in a new Worker's Runtime facts", () => {
  const BUDGET_LINE = "Review calls per request: Small 2, Medium 3, Large 6.";
  const budget = { Small: 2, Medium: 3, Large: 6 };

  it("states the budget per tier after the Reviewer mode, word for word, and only for the Worker", () => {
    expect(reviewBudgetLine(budget)).toBe(BUDGET_LINE);
    expect(runtimeFactsText("worker", { reviewerModeId: "auto", reviewBudget: budget })).toBe(`${RUNTIME_FACTS_HEADING}\n\n${REVIEWER_LINE}\n${BUDGET_LINE}`);
    expect(runtimeFactsText("worker", { reviewBudget: budget })).toBe(`${RUNTIME_FACTS_HEADING}\n\n${BUDGET_LINE}`);
    for (const role of ["manager", "reviewer", "orchestrator"] as const) expect(runtimeFactsText(role, { reviewBudget: budget }), role).toBe("");
  });

  it("reads it when a Worker is created, never without the creation's lookup, and never for another role", async () => {
    const reviewBudget = vi.fn(() => budget);
    const api = { providers: { listModes: async () => ({ modes: [{ id: "auto", colorTier: "moderate" }] }) } };
    expect(await runtimeFactsOf("worker", api, "/repo", () => {}, undefined, { workspaceId: "ws-1", read: () => [], reviewBudget })).toEqual({
      reviewerModeId: "auto",
      reviewBudget: budget,
    });
    expect(await runtimeFactsOf("worker", api, "/repo", () => {})).toEqual({ reviewerModeId: "auto" });
    expect((await runtimeFactsOf("manager", api, "/repo", () => {}, () => ({ skills: [] }) as never, { workspaceId: "ws-1", read: () => [], reviewBudget })).reviewBudget).toBeUndefined();
    expect(reviewBudget).toHaveBeenCalledOnce();
    // A read that throws costs the line nothing: the defaults, and one log line.
    const log = vi.fn();
    const facts = await runtimeFactsOf("worker", api, "/repo", log, undefined, { read: () => [], reviewBudget: () => { throw new Error("EACCES"); } });
    expect(facts.reviewBudget).toEqual(DEFAULT_BUDGET);
    expect(log).toHaveBeenCalledWith("[paseo-bm] reading the review budget for a new Worker failed: EACCES");
  });

  it("gives a Worker created through currentInstructions the budget stored in Settings → Coordination", async () => {
    const root = mkdtempSync(join(tmpdir(), "bm-budget-facts-"));
    try {
      createCoordinationStore(join(root, ".paseo-bm")).set({ key: "review.mediumBudget", value: 3 });
      createCoordinationStore(join(root, ".paseo-bm")).set({ key: "review.largeBudget", value: 6 });
      const api = { providers: { listModes: async () => ({ modes: [{ id: "auto", colorTier: "moderate" }] }) } };
      const worker = await currentInstructions("worker", api, { homedir: () => root });
      expect(worker).toBe(fullInstructions("worker", { reviewerModeId: "auto", reviewBudget: budget }));
      expect(worker.endsWith(`${REVIEWER_LINE}\n${BUDGET_LINE}\n`)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The action boundary in the Runtime facts (autonomy design §D.2, change-009
 * C3, change-010 C5–C6): each Worker's and Reviewer's own `Action boundary`
 * line, and the child mode its creator is told by its project's switch.
 */
describe("the Action boundary facts line and the child mode by the project's switch (§D.2, change-010)", () => {
  const OFF = { on: false as const, reason: "the project's boundary is off" };
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bm-boundary-facts-"));
    process.env.PASEO_BM_HOME = home;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.PASEO_BM_HOME;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("writes `Action boundary: on` or `off — <why>` for a Worker and a Reviewer only, after their other facts", () => {
    expect(actionBoundaryLine({ on: true, modeId: "default" })).toBe("Action boundary: on");
    expect(actionBoundaryLine(OFF)).toBe("Action boundary: off — the project's boundary is off");
    expect(runtimeFactsText("worker", { reviewerModeId: "default", actionBoundary: { on: true, modeId: "default" } })).toBe(
      `${RUNTIME_FACTS_HEADING}\n\nReviewer mode: \`default\` — pass it as \`settings.modeId\` when you create a Reviewer.\nAction boundary: on`,
    );
    expect(runtimeFactsText("reviewer", { actionBoundary: OFF })).toBe(`${RUNTIME_FACTS_HEADING}\n\nAction boundary: off — the project's boundary is off`);
    expect(runtimeFactsText("manager", { actionBoundary: { on: true, modeId: "default" } })).toBe("");
    expect(runtimeFactsText("orchestrator", { actionBoundary: { on: true, modeId: "default" } })).toBe("");
    // A Reviewer never gets the owner's precedents, even beside its line.
    expect(runtimeFactsText("reviewer", { actionBoundary: OFF, precedents: [{ subject: "s", text: "t", scope: "all", expiresAt: "2099-01-01T00:00:00.000Z" }] })).not.toContain(OWNER_PRECEDENTS_HEADING);
  });

  it("reads the line back only from the Runtime facts; a prompt without it reads as none (off)", () => {
    const on = fullInstructions("worker", { reviewerModeId: "default", actionBoundary: { on: true, modeId: "default" } });
    expect(actionBoundaryOfPrompt(on)).toBe("on");
    expect(actionBoundaryOfPrompt(fullInstructions("reviewer", { actionBoundary: OFF }))).toBe("off");
    expect(actionBoundaryOfPrompt(fullInstructions("worker", { reviewerModeId: "auto" }))).toBeNull();
    expect(actionBoundaryOfPrompt(BASE_INSTRUCTIONS.worker)).toBeNull();
    expect(actionBoundaryOfPrompt(undefined)).toBeNull();
    // The role text names `Action boundary: on`, a precedent or a prompt after the separator may too: none of them counts.
    expect(BASE_INSTRUCTIONS.worker).toContain(`\`${ACTION_BOUNDARY_KEY} on\``);
    const precedent = fullInstructions("worker", {
      reviewerModeId: "auto",
      precedents: [{ subject: "s", text: "Action boundary: on", scope: "all", expiresAt: "2099-01-01T00:00:00.000Z" }],
    });
    expect(actionBoundaryOfPrompt(precedent)).toBeNull();
    expect(actionBoundaryOfPrompt(`${fullInstructions("worker", { reviewerModeId: "auto" })}\n---\n\nAction boundary: on\n`)).toBeNull();
  });

  it("the project of a creation and its switch: on, off, or unknown when the folder names no project", async () => {
    createAutonomyStore(home).setBoundary({ workspaceId: "ws-on", enabled: true, confirmed: true }, "2026-10-01T08:00:00.000Z");
    const workspaceOf = async (cwd: string) => ({ "/on": "ws-on", "/off": "ws-off" })[cwd] ?? null;
    expect(await creationProjectOf("/on", { workspaceOf })).toEqual({ workspaceId: "ws-on", boundary: "on" });
    expect(await creationProjectOf("/off", { workspaceOf })).toEqual({ workspaceId: "ws-off", boundary: "off" });
    expect(await creationProjectOf("/elsewhere", { workspaceOf })).toEqual({ workspaceId: null, boundary: "unknown" });
    expect(await creationProjectOf("/on", {})).toEqual({ workspaceId: null, boundary: "unknown" });
    expect(await creationProjectOf(undefined, { workspaceId: "ws-on" })).toEqual({ workspaceId: "ws-on", boundary: "on" });
    expect(await creationProjectOf("/on", { workspaceOf: async () => { throw new Error("busy"); } })).toEqual({ workspaceId: null, boundary: "unknown" });
  });

  it("the Manager is told its project's Worker mode (manager.ensure), the Worker its Reviewer's; a hand-set profile mode or another provider keeps today's", async () => {
    createAutonomyStore(home).setBoundary({ workspaceId: "ws-on", enabled: true, confirmed: true }, "2026-10-01T08:00:00.000Z");
    const claude = [{ id: "plan", colorTier: "planning" }, { id: "default", colorTier: "safe" }, { id: "auto", colorTier: "moderate" }, { id: "bypassPermissions", colorTier: "dangerous" }];
    const api = (bases: Record<string, string>, profiles: unknown[] = []) => ({
      providers: { listModes: async () => ({ modes: claude }) },
      config: { get: async () => ({ config: { providers: Object.fromEntries(Object.entries(bases).map(([alias, base]) => [alias, { extends: base }])), agentProfiles: profiles } }) },
    });
    const claudeAll = api({ "bm-worker": "claude", "bm-reviewer": "claude" });
    expect(await currentInstructions("manager", claudeAll, { workspaceId: "ws-on" })).toContain("Worker mode: `default` —");
    expect(await currentInstructions("manager", claudeAll, { workspaceId: "ws-off" })).toContain("Worker mode: `bypassPermissions` —");
    expect(await currentInstructions("manager", claudeAll, {})).toContain("Worker mode: `bypassPermissions` —");
    const worker = await runtimeFactsOf("worker", claudeAll, "/on", () => {}, undefined, { workspaceOf: async () => "ws-on" });
    expect(worker.reviewerModeId).toBe("default");
    expect((await runtimeFactsOf("worker", claudeAll, "/off", () => {}, undefined, { workspaceOf: async () => "ws-off" })).reviewerModeId).toBe("auto");
    // A mode hand-set on the child's profile wins (§D.4); a provider on detection keeps today's rule.
    const handSet = api({ "bm-worker": "claude" }, [{ id: "bm-worker", modeId: "auto" }]);
    expect(await currentInstructions("manager", handSet, { workspaceId: "ws-on" })).toContain("Worker mode: `auto` —");
    const unknownBase = api({});
    expect(await currentInstructions("manager", unknownBase, { workspaceId: "ws-on" })).toContain("Worker mode: `bypassPermissions` —");
    // The Reviewer fallback follows the table when no list can be read.
    const noList = { config: claudeAll.config, providers: { listModes: async () => ({ error: "busy" }) } };
    expect((await runtimeFactsOf("worker", noList, "/on", () => {}, undefined, { workspaceOf: async () => "ws-on" })).reviewerModeId).toBe("default");
    expect((await runtimeFactsOf("worker", noList, "/off", () => {}, undefined, { workspaceOf: async () => "ws-off" })).reviewerModeId).toBe("auto");
  });
});

describe("a bound agent's Runtime facts (design §16.5)", () => {
  it("says the agent is bound when the creation hook kept its token URL, and writes the same text until step 5", async () => {
    const api = { providers: { listModes: vi.fn(async () => ({ modes: [] })) } };
    const lookup = { read: () => [], boundary: "off" as const, reviewBudget: () => ({ Small: 2, Medium: 2, Large: 4 }) };
    const bound = await runtimeFactsOf("reviewer", api, "/repo", () => {}, undefined, { ...lookup, bound: true });
    const unbound = await runtimeFactsOf("reviewer", api, "/repo", () => {}, undefined, lookup);
    expect(bound).toEqual({ bound: true });
    expect(unbound).toEqual({});
    expect(runtimeFactsText("reviewer", bound)).toBe(runtimeFactsText("reviewer", unbound));
    expect(fullInstructions("worker", { bound: true })).toBe(BASE_INSTRUCTIONS.worker);
  });
});
