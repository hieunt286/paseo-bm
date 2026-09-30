/**
 * Evaluation scenarios: the schema of `scripts/eval/scenarios/<id>.json` and
 * its loaders (design docs/design/paseo-bm-evaluation.md §6.1).
 *
 * A scenario is data, so a later phase adds one without code. The `expect`
 * block is the vocabulary the scoring reads (§6.4); every check in it is
 * something the scorer can decide from the repository, the bead graph, the
 * isolated trace store and the simulated owner's log after the agents are idle.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Scenario ids are `S` followed by a number; the file is named after the id. */
const ScenarioId = z.string().regex(/^S[0-9]+$/, "a scenario id is S followed by a number");

/**
 * A path in the scenario's repository, relative to its root. A value ending in
 * `/` means "any file under this directory".
 */
const RepoPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "a repository-relative path");

/** A bead the fixture creates before any agent runs (S5). */
export const SeededBeadSchema = z.strictObject({
  /** The name `expect` uses for this bead; also its `--slug`. br picks the real id. */
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1),
  description: z.string().min(1),
  type: z.enum(["task", "feature", "bug"]).default("task"),
  priority: z.number().int().min(0).max(4).default(2),
});

export const FixtureSchema = z.strictObject({
  /**
   * `node`: the small Node project (math.js, node:test, `npm test`), S1–S7.
   * `ts-two-package`: a library and a consumer package in TypeScript, S8.
   */
  kind: z.enum(["node", "ts-two-package"]),
  /**
   * `node` only: also a small CLI (`cli.js`) printing JSON, a script in the
   * repository that consumes it, and the document describing that contract (S4).
   */
  cli: z.boolean().default(false),
  seededBeads: z.array(SeededBeadSchema).default([]),
  /** A local bare repository as `origin`, holding the initial commit (S7). */
  bareRemote: z.boolean().default(false),
});

export const RequestSchema = z.strictObject({
  /** Text sent to the Manager, as the owner would type it. */
  text: z.string().min(1),
  /** Seconds to wait after the previous request (or the start) before sending this one. */
  delaySeconds: z.number().int().min(0).default(0),
});

/** The owner's answer to a question whose text contains the keyword. */
const OwnerAnswer = z.union([
  z.strictObject({ option: z.string().regex(/^[A-Z]$/, "an option letter") }),
  z.strictObject({ words: z.string().min(1) }),
]);

export const OwnerSchema = z.strictObject({
  /** Every open question gets the recommended option unless an override matches. */
  policy: z.literal("recommended").default("recommended"),
  /** Matched case-insensitively against the question text; the first match wins. */
  overrides: z
    .array(z.strictObject({ keyword: z.string().min(1), answer: OwnerAnswer }))
    .default([]),
});

/** The request's size as the Worker classifies it. */
export const Tier = z.enum(["small", "medium", "large"]);

/**
 * Bead expectations:
 * - `none`: no bead is created or changed (S1);
 * - `created`: at least `min` new beads, each closed with evidence when
 *   `closedWithEvidence`; for every entry of `covering`, one of its alternative
 *   keywords appears (case-insensitively) in the title or description of at
 *   least one new bead (S3: one entry per outcome);
 * - `updated`: no new bead, and the seeded bead named by `seeded` was updated (S5).
 */
export const BeadsExpectation = z.discriminatedUnion("expect", [
  z.strictObject({ expect: z.literal("none") }),
  z.strictObject({
    expect: z.literal("created"),
    min: z.number().int().min(1).default(1),
    closedWithEvidence: z.boolean().default(true),
    covering: z.array(z.array(z.string().min(1)).min(1)).default([]),
  }),
  z.strictObject({ expect: z.literal("updated"), seeded: z.string().min(1) }),
]);

/**
 * Reviewer expectations: `none` (no Reviewer agent is created), or at least
 * `min` reviews, the first one before any source file changed when
 * `beforeImplementation` (S4: the design is reviewed first).
 */
export const ReviewExpectation = z.discriminatedUnion("expect", [
  z.strictObject({ expect: z.literal("none") }),
  z.strictObject({
    expect: z.literal("reviewed"),
    min: z.number().int().min(1).default(1),
    beforeImplementation: z.boolean().default(false),
  }),
]);

/**
 * Git expectations, compared with the fixture's initial commit:
 * - `commit`: `none` (HEAD unchanged) or `required` (at least one new commit);
 * - `push`: `none` (the remote, if any, unchanged) or `afterOwnerYes` (a push
 *   happened, and only after the owner answered yes to a question matching
 *   `keyword`); the remote then equals the local HEAD, so it holds exactly
 *   the commits made in the request.
 */
export const GitExpectation = z.strictObject({
  commit: z.enum(["none", "required"]).default("none"),
  push: z
    .discriminatedUnion("expect", [
      z.strictObject({ expect: z.literal("none") }),
      z.strictObject({ expect: z.literal("afterOwnerYes"), keyword: z.string().min(1) }),
    ])
    .default({ expect: "none" }),
});

/**
 * Keywords of the "or asked about" alternative: met when a question or
 * decision whose text contains any of them (case-insensitively) reached the
 * owner. Empty means the alternative is not accepted.
 */
const OrAsked = z.array(z.string().min(1)).default([]);

/** An outcome met by the repository (any one of `paths` changed) or by asking the owner. */
const ChangedOrAsked = z.strictObject({
  paths: z.array(RepoPath).min(1),
  orAsked: OrAsked,
});

/**
 * A command that must still succeed in the repository (S4: the consumer of the
 * CLI output), or a question about it reached the owner. `argv` is run without
 * a shell in the repository root; `argv[0]` of `node` means the running Node.
 */
const CommandOrAsked = z.strictObject({
  argv: z.array(z.string().min(1)).min(1),
  orAsked: OrAsked,
});

export const ExpectSchema = z.strictObject({
  /** The tiers accepted for the request (S8: medium or large). */
  tier: z.array(Tier).min(1),
  /** Absent: the scenario says nothing about beads, so they are not scored. */
  beads: BeadsExpectation.optional(),
  /** Absent: reviews are not scored. */
  review: ReviewExpectation.optional(),
  /** `npm test` in the repository passes after the agents are idle. */
  testsGreen: z.boolean().default(true),
  git: GitExpectation.default({ commit: "none", push: { expect: "none" } }),
  /** Each path must differ from the initial commit (working tree or new commits). */
  changed: z.array(RepoPath).default([]),
  /** Each text must appear in the file after the run (S6: both changes kept). */
  contains: z.array(z.strictObject({ path: RepoPath, text: z.string().min(1) })).default([]),
  /** Keywords that must each appear in a question or decision that reached the owner. */
  askedOwner: z.array(z.string().min(1)).default([]),
  /** The contract document is updated, or the change was asked about (S4, S8). */
  contractDoc: ChangedOrAsked.optional(),
  /** The consumer still works, or the change was asked about (S4). */
  consumerWorks: CommandOrAsked.optional(),
  /**
   * Concurrent requests (S6): no two Workers edit one of `noOverlappingEdits`
   * in overlapping turns, and a Worker that has to wait is told whom it waits for.
   */
  concurrency: z
    .strictObject({
      noOverlappingEdits: z.array(RepoPath).min(1),
      waiterToldWhom: z.boolean().default(true),
    })
    .optional(),
});

export const ScenarioSchema = z
  .strictObject({
    id: ScenarioId,
    title: z.string().min(1),
    fixture: FixtureSchema,
    requests: z.array(RequestSchema).min(1),
    owner: OwnerSchema.default({ policy: "recommended", overrides: [] }),
    expect: ExpectSchema,
    timeoutMinutes: z.number().int().min(1).max(240),
  })
  .superRefine((s, ctx) => {
    const keys = new Set(s.fixture.seededBeads.map((b) => b.key));
    if (keys.size !== s.fixture.seededBeads.length) {
      ctx.addIssue({ code: "custom", path: ["fixture", "seededBeads"], message: "seeded bead keys must be unique" });
    }
    if (s.expect.beads?.expect === "updated" && !keys.has(s.expect.beads.seeded)) {
      ctx.addIssue({ code: "custom", path: ["expect", "beads", "seeded"], message: "names no seeded bead" });
    }
    if (s.expect.git.push.expect !== "none" && !s.fixture.bareRemote) {
      ctx.addIssue({ code: "custom", path: ["expect", "git", "push"], message: "a push needs fixture.bareRemote" });
    }
    if (s.fixture.cli && s.fixture.kind !== "node") {
      ctx.addIssue({ code: "custom", path: ["fixture", "cli"], message: "only the node fixture has a CLI" });
    }
  });

export type SeededBead = z.infer<typeof SeededBeadSchema>;
export type Fixture = z.infer<typeof FixtureSchema>;
export type ScenarioRequest = z.infer<typeof RequestSchema>;
export type Owner = z.infer<typeof OwnerSchema>;
export type Expect = z.infer<typeof ExpectSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;

/** `scripts/eval/scenarios/` next to this file. */
export const SCENARIOS_DIR = join(dirname(fileURLToPath(import.meta.url)), "scenarios");

/** Parses one scenario file; throws with the file name and the schema errors. */
export async function loadScenario(file: string): Promise<Scenario> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`${file}: not readable JSON (${(err as Error).message})`);
  }
  const parsed = ScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${file}: invalid scenario\n${z.prettifyError(parsed.error)}`);
  }
  if (basename(file) !== `${parsed.data.id}.json`) {
    throw new Error(`${file}: the file must be named ${parsed.data.id}.json`);
  }
  return parsed.data;
}

/** The scenario files of `dir`, ordered by their number (S1, S2, …, S10). */
export async function listScenarioFiles(dir: string = SCENARIOS_DIR): Promise<string[]> {
  const names = (await readdir(dir)).filter((n) => /^S[0-9]+\.json$/.test(n));
  const num = (n: string) => Number(n.slice(1, -".json".length));
  return names.sort((a, b) => num(a) - num(b)).map((n) => join(dir, n));
}

/** Every scenario of `dir`, validated, in order. */
export async function loadAllScenarios(dir: string = SCENARIOS_DIR): Promise<Scenario[]> {
  const files = await listScenarioFiles(dir);
  return Promise.all(files.map((f) => loadScenario(f)));
}
