/**
 * WP-106 — role configuration (bm-wp-106-7zj.1).
 *
 * Three things are proved here:
 *
 * 1. `--role` syntax is judged at argument-parsing time, so a malformed value
 *    ends the run with exit code 2 and `E_BAD_ROLE_SPEC` before any command
 *    handler is entered and therefore before a single byte is written. The
 *    write-scope harness watches the filesystem to make "zero writes" a
 *    measurement rather than a claim.
 * 2. Whether a provider/model pair exists is a *separate* tier, run against a
 *    fake catalogue, and reports `E_PROVIDER_UNAVAILABLE`.
 * 3. The interactive flow asks for all three roles — the Reviewer gets its own
 *    questions and never inherits the Worker's answer (Q-020) — and a session
 *    with no terminal takes defaults with a warning instead of hanging.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { CommandContext, CommandHandlers, Writer } from "../src/cli.js";
import { EXIT_CODES } from "../src/flags.js";
import type { PaseoInvocation } from "../src/paseo/adapter.js";
import { PaseoCliError } from "../src/paseo/adapter.js";
import { NonInteractivePrompter, ScriptedPrompter } from "../src/prompter.js";
import type { Prompter, TtyInfo } from "../src/prompter.js";
import type { RoleRecord } from "../src/record.js";
import {
  DEFAULT_ROLE_DISPLAY_NAMES,
  MAX_ROLE_SPEC_LENGTH,
  PROVIDER_LIST_ARGV,
  RoleConfigError,
  configureRoles,
  createStaticCatalog,
  findRoleSpec,
  loadProviderCatalog,
  parseModelList,
  parseProviderList,
  parseRoleSpec,
  parseRoleSpecs,
  providerModelsArgv,
  roleGrantsPaseoTools,
  toRoleRecord,
  toRoleRecords,
  validateRoleSpecs,
} from "../src/roles/config.js";
import type { ProviderEntry } from "../src/roles/config.js";
import { startWriteScope } from "./helpers/write-scope.js";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Shaped like the real `paseo provider ls/models --json` output of Paseo 0.8.0. */
const CATALOG_ENTRIES: readonly ProviderEntry[] = [
  {
    id: "claude",
    label: "Claude",
    available: true,
    models: [
      { id: "claude-opus-5", label: "Opus 5", defaultThinkingOptionId: "high" },
      { id: "claude-opus-4-8[1m]", label: "Opus 4.8 1M", defaultThinkingOptionId: "high" },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    available: true,
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", defaultThinkingOptionId: "xhigh" },
      { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", defaultThinkingOptionId: "xhigh" },
    ],
  },
  {
    id: "pi",
    label: "Pi",
    available: true,
    // A real Pi model id: the model half of a --role value can contain slashes.
    models: [{ id: "dx-ai-dev/Qwen/Qwen3.6-35B-A3B-FP8", label: "Qwen3.6", defaultThinkingOptionId: null }],
  },
  { id: "copilot", label: "Copilot", available: false, models: [] },
];

const catalog = (): ReturnType<typeof createStaticCatalog> => createStaticCatalog(CATALOG_ENTRIES);

const TTY: TtyInfo = { stdin: true, stdout: true, interactive: true };

interface Harness {
  readonly out: () => string;
  readonly err: () => string;
  readonly seen: CommandContext[];
  readonly handlers: CommandHandlers;
  readonly stdout: Writer;
  readonly stderr: Writer;
}

function harness(): Harness {
  let out = "";
  let err = "";
  const seen: CommandContext[] = [];
  const make = () => (context: CommandContext) => {
    seen.push(context);
    return EXIT_CODES.ok;
  };
  return {
    out: () => out,
    err: () => err,
    seen,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    handlers: { install: make(), doctor: make(), uninstall: make() },
  };
}

function run(argv: readonly string[], h: Harness, prompter?: Prompter): Promise<number> {
  return runCli(argv, {
    handlers: h.handlers,
    stdout: h.stdout,
    stderr: h.stderr,
    env: {},
    tty: TTY,
    createPrompter: () => prompter ?? new ScriptedPrompter({}),
  });
}

/* ------------------------------------------------------------------ *
 * Tier 1 — syntax, at parse time
 * ------------------------------------------------------------------ */

describe("parseRoleSpec — tier 1 accepts exactly the documented syntax", () => {
  it.each([
    ["worker=codex/gpt-5.6-sol", "worker", "codex", "gpt-5.6-sol"],
    ["manager=claude/claude-opus-5", "manager", "claude", "claude-opus-5"],
    ["reviewer=claude/claude-opus-4-8[1m]", "reviewer", "claude", "claude-opus-4-8[1m]"],
    // The provider is split off at the FIRST slash, so a model id may contain
    // slashes of its own — Pi and OpenCode models really do.
    ["worker=pi/dx-ai-dev/Qwen/Qwen3.6-35B-A3B-FP8", "worker", "pi", "dx-ai-dev/Qwen/Qwen3.6-35B-A3B-FP8"],
    ["  worker=codex/gpt-5.6-sol  ", "worker", "codex", "gpt-5.6-sol"],
  ])("accepts %s", (value, role, provider, model) => {
    const parsed = parseRoleSpec(value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.spec).toEqual({ role, provider, model });
  });

  it.each([
    ["", "empty value"],
    ["worker", "no = at all"],
    ["worker=codex", "no / between provider and model"],
    ["designer=codex/gpt-5.6-sol", "unknown role name"],
    ["Worker=codex/gpt-5.6-sol", "role name in the wrong case"],
    ["=codex/gpt-5.6-sol", "no role before the ="],
    ["worker=/gpt-5.6-sol", "empty provider"],
    ["worker=codex/", "empty model"],
    ["worker=co dex/gpt-5.6-sol", "space inside the provider"],
    ["worker=codex/gpt 5.6", "space inside the model"],
    ["worker=-codex/gpt-5.6-sol", "provider starting with a dash"],
    ["worker=codex/;rm -rf /", "shell metacharacters"],
    ["worker=codex/$(whoami)", "command substitution"],
    [`worker=codex/${"m".repeat(MAX_ROLE_SPEC_LENGTH)}`, "absurdly long value"],
  ])("rejects %s (%s) with E_BAD_ROLE_SPEC", (value) => {
    const parsed = parseRoleSpec(value);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("E_BAD_ROLE_SPEC");
    expect(parsed.error.hint).toContain("--role");
  });

  it("names the three roles when the role is wrong", () => {
    const parsed = parseRoleSpec("designer=codex/gpt-5.6-sol");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("manager, worker, reviewer");
  });
});

describe("parseRoleSpecs — the repeatable flag as a whole", () => {
  it("keeps every value, in the order they were typed", () => {
    const parsed = parseRoleSpecs([
      "manager=claude/claude-opus-5",
      "worker=codex/gpt-5.6-sol",
      "reviewer=pi/dx-ai-dev/Qwen/Qwen3.6-35B-A3B-FP8",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.specs.map((spec) => spec.role)).toEqual(["manager", "worker", "reviewer"]);
    expect(findRoleSpec(parsed.specs, "worker")?.model).toBe("gpt-5.6-sol");
    expect(findRoleSpec(parsed.specs, "manager")?.provider).toBe("claude");
  });

  it("accepts an absent flag as an empty list", () => {
    const parsed = parseRoleSpecs([]);
    expect(parsed).toEqual({ ok: true, specs: [] });
  });

  it("rejects the same role twice instead of silently picking one", () => {
    const parsed = parseRoleSpecs(["worker=codex/gpt-5.6-sol", "worker=claude/claude-opus-5"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("E_BAD_ROLE_SPEC");
    expect(parsed.error.message).toContain("more than once");
  });

  it("reports the first bad value and stops", () => {
    const parsed = parseRoleSpecs(["worker=nonsense", "reviewer=also-nonsense"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("worker=nonsense");
  });
});

/* ------------------------------------------------------------------ *
 * Tier 1 through the CLI: exit code 2, zero writes
 * ------------------------------------------------------------------ */

describe("runCli — a malformed --role is exit code 2 with zero writes", () => {
  let tmp = "";

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "paseo-bm-role-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it.each([
    ["nonsense", ["install", "--role", "nonsense"]],
    ["unknown role", ["install", "--role", "designer=codex/gpt-5.6-sol"]],
    ["missing model", ["install", "--role=worker=codex"]],
    ["empty provider", ["install", "--role=worker=/gpt-5.6-sol"]],
    ["duplicate role", ["install", "--role=worker=codex/a", "--role=worker=claude/b"]],
    ["bad second value", ["install", "--apply", "--role=worker=codex/gpt-5.6-sol", "--role=reviewer=bad"]],
  ])("%s", async (_label, argv) => {
    const h = harness();
    const scope = startWriteScope({
      installHome: join(tmp, "home"),
      paseoHome: join(tmp, "paseo"),
      watch: [tmp],
    });
    try {
      const code = await run(argv, h);
      expect(code).toBe(EXIT_CODES.usage);
      expect(h.err()).toContain("E_BAD_ROLE_SPEC");
      // Exit code 2 happens before the command handler runs, so nothing that
      // could write was ever reached.
      expect(h.seen).toHaveLength(0);
      expect(h.out()).toBe("");
      expect(scope.writes).toHaveLength(0);
      scope.assertNoViolations();
    } finally {
      scope.restore();
    }
  });

  it("prints the remediation from the diagnostic registry", async () => {
    const h = harness();
    await run(["install", "--role", "designer=codex/gpt-5.6-sol"], h);
    expect(h.err()).toContain("Nothing was written.");
  });

  it("hands a valid --role to the command as parsed specs", async () => {
    const h = harness();
    const code = await run(["install", "--role=worker=codex/gpt-5.6-sol", "--role=reviewer=claude/claude-opus-5"], h);
    expect(code).toBe(EXIT_CODES.ok);
    expect(h.seen[0]?.roleSpecs).toEqual([
      { role: "worker", provider: "codex", model: "gpt-5.6-sol" },
      { role: "reviewer", provider: "claude", model: "claude-opus-5" },
    ]);
  });

  it("leaves roleSpecs empty when the flag is absent", async () => {
    const h = harness();
    await run(["install"], h);
    expect(h.seen[0]?.roleSpecs).toEqual([]);
  });

  it("does not consult Paseo at parse time: a syntactically valid but unknown pair still runs", async () => {
    const h = harness();
    const code = await run(["install", "--role=worker=nosuchprovider/nosuchmodel"], h);
    expect(code).toBe(EXIT_CODES.ok);
    expect(h.seen).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Tier 2 — existence, against the catalogue
 * ------------------------------------------------------------------ */

describe("validateRoleSpecs — tier 2 checks what Paseo really offers", () => {
  it("passes a pair that exists", async () => {
    const parsed = parseRoleSpecs(["worker=codex/gpt-5.6-sol"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await expect(validateRoleSpecs(parsed.specs, catalog())).resolves.toEqual({ ok: true });
  });

  it("reports E_PROVIDER_UNAVAILABLE for a provider Paseo does not have", async () => {
    const check = await validateRoleSpecs([{ role: "worker", provider: "ghost", model: "x" }], catalog());
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.errors[0]?.code).toBe("E_PROVIDER_UNAVAILABLE");
    expect(check.errors[0]?.missing).toBe("provider");
    expect(check.errors[0]?.message).toContain("claude, codex, pi, copilot");
  });

  it("reports E_PROVIDER_UNAVAILABLE for a model that provider does not have", async () => {
    const check = await validateRoleSpecs([{ role: "reviewer", provider: "codex", model: "gpt-4" }], catalog());
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.errors[0]?.missing).toBe("model");
    expect(check.errors[0]?.message).toContain("gpt-5.6-sol");
  });

  it("reports every bad spec, not just the first", async () => {
    const check = await validateRoleSpecs(
      [
        { role: "manager", provider: "ghost", model: "x" },
        { role: "worker", provider: "codex", model: "gpt-4" },
      ],
      catalog(),
    );
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.errors.map((error) => error.role)).toEqual(["manager", "worker"]);
  });
});

describe("loadProviderCatalog — read-only calls and defensive parsing", () => {
  const invocation = (argv: readonly string[], stdout: string): PaseoInvocation => ({
    argv,
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 1,
  });

  function runner(seen: string[][], responses: Record<string, string>) {
    return {
      run: (args: readonly string[]): Promise<PaseoInvocation> => {
        seen.push([...args]);
        const key = args.join(" ");
        return Promise.resolve(invocation(args, responses[key] ?? "[]"));
      },
    };
  }

  it("lists providers and fetches models lazily, once per provider", async () => {
    const seen: string[][] = [];
    const loaded = await loadProviderCatalog(
      runner(seen, {
        [PROVIDER_LIST_ARGV.join(" ")]: JSON.stringify([
          { provider: "codex", label: "Codex", status: "available" },
          { provider: "copilot", label: "Copilot", status: "unavailable" },
        ]),
        [providerModelsArgv("codex").join(" ")]: JSON.stringify([
          { model: "GPT-5.6-Sol", id: "gpt-5.6-sol", defaultThinkingOptionId: "xhigh" },
        ]),
      }),
    );

    expect(loaded.providers).toEqual([
      { id: "codex", label: "Codex", available: true },
      { id: "copilot", label: "Copilot", available: false },
    ]);
    expect(await loaded.models("codex")).toEqual([
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", defaultThinkingOptionId: "xhigh" },
    ]);
    await loaded.models("codex");
    expect(seen).toEqual([[...PROVIDER_LIST_ARGV], [...providerModelsArgv("codex")]]);
  });

  it("never asks Paseo about a provider it did not list", async () => {
    const seen: string[][] = [];
    const loaded = await loadProviderCatalog(
      runner(seen, { [PROVIDER_LIST_ARGV.join(" ")]: JSON.stringify([{ provider: "codex" }]) }),
    );
    expect(await loaded.models("ghost")).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it("rejects a payload that is not a provider list", () => {
    expect(() => parseProviderList({ nope: true }, ["provider", "ls"])).toThrow(PaseoCliError);
    expect(() => parseProviderList([{ label: "no id" }], ["provider", "ls"])).toThrow(PaseoCliError);
    expect(() => parseModelList("text", ["provider", "models", "codex"])).toThrow(PaseoCliError);
  });

  it("accepts the wrapped object shape and a missing status", () => {
    expect(parseProviderList({ providers: [{ id: "codex" }] }, ["provider", "ls"])).toEqual([
      { id: "codex", label: "codex", available: true },
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Tier 3 — the questions
 * ------------------------------------------------------------------ */

describe("configureRoles — the interactive flow asks for all three roles", () => {
  it("asks name, provider and model for manager, worker and reviewer", async () => {
    const prompter = new ScriptedPrompter({
      input: ["Beads Manager", "Beads Worker", "Beads Reviewer"],
      select: ["claude", "claude-opus-5", "codex", "gpt-5.6-sol", "pi", "dx-ai-dev/Qwen/Qwen3.6-35B-A3B-FP8"],
    });

    const configured = await configureRoles({ specs: [], catalog: catalog(), prompter });

    expect(configured.selections.map((selection) => selection.role)).toEqual(["manager", "worker", "reviewer"]);
    expect(configured.selections.map((selection) => `${selection.provider}/${selection.model}`)).toEqual([
      "claude/claude-opus-5",
      "codex/gpt-5.6-sol",
      "pi/dx-ai-dev/Qwen/Qwen3.6-35B-A3B-FP8",
    ]);
    expect(configured.questionsAsked).toBe(9);
    expect(prompter.counts).toEqual({ confirm: 0, input: 3, select: 6, total: 9 });
    expect(configured.warnings).toEqual([]);
  });

  /**
   * Q-020: the Reviewer is its own question. If it were defaulted to the
   * Worker's answer there would be no way to review with a second opinion from
   * a different tool, so this asserts the Reviewer is asked and can differ.
   */
  it("asks the Reviewer separately and never inherits the Worker's choice", async () => {
    const prompter = new ScriptedPrompter({
      input: ["Beads Manager", "Beads Worker", "Beads Reviewer"],
      select: ["codex", "gpt-5.6-sol", "codex", "gpt-5.6-sol", "claude", "claude-opus-5"],
    });

    const configured = await configureRoles({ specs: [], catalog: catalog(), prompter });

    const reviewer = configured.selections.find((selection) => selection.role === "reviewer");
    const worker = configured.selections.find((selection) => selection.role === "worker");
    expect(worker?.provider).toBe("codex");
    expect(reviewer?.provider).toBe("claude");
    const reviewerQuestions = prompter.asked.filter((record) => record.message.includes("Reviewer"));
    expect(reviewerQuestions).toHaveLength(3);
    expect(reviewerQuestions[0]?.details.join(" ")).toContain("independent");
  });

  it("uses the typed name, and the default name when the answer is blank", async () => {
    const prompter = new ScriptedPrompter({
      input: ["Boss", "   ", "Second Opinion"],
      select: ["codex", "gpt-5.6-sol", "codex", "gpt-5.6-sol", "codex", "gpt-5.6-sol"],
    });
    const configured = await configureRoles({ specs: [], catalog: catalog(), prompter });
    expect(configured.selections.map((selection) => selection.displayName)).toEqual([
      "Boss",
      DEFAULT_ROLE_DISPLAY_NAMES.worker,
      "Second Opinion",
    ]);
  });

  it("does not ask about a role that --role already decided", async () => {
    const prompter = new ScriptedPrompter({
      input: ["Beads Manager", "Beads Reviewer"],
      select: ["claude", "claude-opus-5", "claude", "claude-opus-5"],
    });
    const parsed = parseRoleSpecs(["worker=codex/gpt-5.6-sol"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const configured = await configureRoles({ specs: parsed.specs, catalog: catalog(), prompter });

    expect(configured.questionsAsked).toBe(6);
    expect(prompter.asked.some((record) => record.message.includes("Worker"))).toBe(false);
    const worker = configured.selections.find((selection) => selection.role === "worker");
    expect(worker).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", source: "flag" });
  });

  it("reuses a recorded configuration without asking, and re-asks under --reconfigure", async () => {
    const existing: readonly RoleRecord[] = ["manager", "worker", "reviewer"].map((role) => ({
      role: role as RoleRecord["role"],
      providerId: `bm-${role}`,
      profileId: `bm-${role}`,
      baseProvider: "codex",
      model: "gpt-5.6-sol",
      modeId: null,
      thinkingOptionId: null,
      paseoTools: role !== "reviewer",
    }));

    const quiet = new ScriptedPrompter({});
    const reused = await configureRoles({ specs: [], catalog: catalog(), prompter: quiet, existing });
    expect(quiet.counts.total).toBe(0);
    expect(reused.selections.every((selection) => selection.source === "record")).toBe(true);

    const asked = new ScriptedPrompter({
      input: ["Beads Manager", "Beads Worker", "Beads Reviewer"],
      select: ["claude", "claude-opus-5", "claude", "claude-opus-5", "claude", "claude-opus-5"],
    });
    const redone = await configureRoles({
      specs: [],
      catalog: catalog(),
      prompter: asked,
      existing,
      reconfigure: true,
    });
    expect(redone.questionsAsked).toBe(9);
    expect(redone.selections.every((selection) => selection.provider === "claude")).toBe(true);
  });

  it("asks again, with a warning, when a recorded provider has disappeared", async () => {
    const existing: readonly RoleRecord[] = [
      {
        role: "worker",
        providerId: "bm-worker",
        profileId: "bm-worker",
        baseProvider: "gone",
        model: "old",
        modeId: null,
        thinkingOptionId: null,
        paseoTools: true,
      },
    ];
    const prompter = new ScriptedPrompter({
      input: ["Beads Manager", "Beads Worker", "Beads Reviewer"],
      select: ["codex", "gpt-5.6-sol", "codex", "gpt-5.6-sol", "codex", "gpt-5.6-sol"],
    });
    const configured = await configureRoles({ specs: [], catalog: catalog(), prompter, existing });
    expect(configured.warnings.map((warning) => warning.reason)).toEqual(["recorded-provider-gone"]);
    expect(configured.selections.find((selection) => selection.role === "worker")?.source).toBe("prompt");
  });
});

describe("configureRoles — a session with no terminal takes defaults and never hangs", () => {
  it("configures all three roles without asking anything, and warns for each", async () => {
    const prompter = new NonInteractivePrompter();
    const configured = await configureRoles({ specs: [], catalog: catalog(), prompter });

    expect(configured.questionsAsked).toBe(0);
    expect(configured.selections).toHaveLength(3);
    expect(configured.selections.every((selection) => selection.source === "default")).toBe(true);
    // The first provider Paseo reports as usable, with its first model.
    expect(configured.selections.map((selection) => `${selection.provider}/${selection.model}`)).toEqual([
      "claude/claude-opus-5",
      "claude/claude-opus-5",
      "claude/claude-opus-5",
    ]);
    expect(configured.warnings.map((warning) => warning.role)).toEqual(["manager", "worker", "reviewer"]);
    expect(configured.warnings[0]?.reason).toBe("non-interactive-default");
    expect(configured.warnings[0]?.message).toContain("--role manager=<provider>/<model>");
  });

  it("warns only for the roles that --role did not cover", async () => {
    const parsed = parseRoleSpecs(["manager=codex/gpt-5.6-sol", "worker=codex/gpt-5.6-terra"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const configured = await configureRoles({
      specs: parsed.specs,
      catalog: catalog(),
      prompter: new NonInteractivePrompter(),
    });
    expect(configured.warnings.map((warning) => warning.role)).toEqual(["reviewer"]);
    expect(configured.selections.map((selection) => selection.source)).toEqual(["flag", "flag", "default"]);
  });

  it("asks nothing at all when --role covers every role", async () => {
    const parsed = parseRoleSpecs([
      "manager=claude/claude-opus-5",
      "worker=codex/gpt-5.6-sol",
      "reviewer=codex/gpt-5.6-terra",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const prompter = new ScriptedPrompter({});
    const configured = await configureRoles({ specs: parsed.specs, catalog: catalog(), prompter });
    expect(prompter.counts.total).toBe(0);
    expect(configured.warnings).toEqual([]);
  });

  it("refuses clearly when Paseo offers no provider at all", async () => {
    await expect(
      configureRoles({
        specs: [],
        catalog: createStaticCatalog([]),
        prompter: new NonInteractivePrompter(),
      }),
    ).rejects.toBeInstanceOf(RoleConfigError);
  });
});

/* ------------------------------------------------------------------ *
 * The decision as a record entry
 * ------------------------------------------------------------------ */

describe("toRoleRecord — what gets written into roles[]", () => {
  it("derives bm-* ids and grants Paseo tools to everyone but the Reviewer", async () => {
    const parsed = parseRoleSpecs([
      "manager=claude/claude-opus-5",
      "worker=codex/gpt-5.6-sol",
      "reviewer=codex/gpt-5.6-terra",
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const configured = await configureRoles({
      specs: parsed.specs,
      catalog: catalog(),
      prompter: new NonInteractivePrompter(),
    });
    const records = toRoleRecords(configured);

    expect(records).toEqual([
      {
        role: "manager",
        providerId: "bm-manager",
        profileId: "bm-manager",
        baseProvider: "claude",
        model: "claude-opus-5",
        modeId: null,
        thinkingOptionId: null,
        paseoTools: true,
      },
      {
        role: "worker",
        providerId: "bm-worker",
        profileId: "bm-worker",
        baseProvider: "codex",
        model: "gpt-5.6-sol",
        modeId: null,
        thinkingOptionId: null,
        paseoTools: true,
      },
      {
        role: "reviewer",
        providerId: "bm-reviewer",
        profileId: "bm-reviewer",
        baseProvider: "codex",
        model: "gpt-5.6-terra",
        modeId: null,
        thinkingOptionId: null,
        paseoTools: false,
      },
    ]);
  });

  it("keeps the ADR-006 tool grant in one place", () => {
    expect(roleGrantsPaseoTools("manager")).toBe(true);
    expect(roleGrantsPaseoTools("worker")).toBe(true);
    expect(roleGrantsPaseoTools("reviewer")).toBe(false);
    expect(
      toRoleRecord({
        role: "reviewer",
        displayName: "Beads Reviewer",
        provider: "codex",
        model: "gpt-5.6-sol",
        paseoTools: false,
        source: "flag",
      }).providerId,
    ).toBe("bm-reviewer");
  });
});
