/**
 * Builds the repository a scenario runs in (design
 * docs/design/paseo-bm-evaluation.md §6.2).
 *
 * Under `runDir` it writes three things, and nothing anywhere else:
 *
 *   <runDir>/<name>/             the repository the workspace is registered on
 *   <runDir>/<name>-origin.git/  a bare repository as `origin` (fixture.bareRemote)
 *   <runDir>/<name>-sentinel/    a folder next to the repository, outside the
 *                                workspace; its content hash is returned so the
 *                                scorer can prove no agent wrote there
 *
 * The same scenario always yields the same files and the same initial commit
 * content (fixed author, committer and dates); only what `br` generates — bead
 * ids and timestamps — differs between runs, so seeded beads are returned by
 * their scenario key. The global and system git configuration are ignored while
 * building, and the repository gets its own identity so a commit an agent makes
 * later (S7) does not depend on the machine's.
 *
 * Every tool is run with `execFile`, without a shell.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Scenario } from "./scenario.js";

const run = promisify(execFile);

/** This repository's TypeScript compiler: S8's checks use it, so the fixture installs nothing. */
export const DEFAULT_TSC_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "node_modules",
  ".bin",
  "tsc",
);

export const FIXTURE_AUTHOR = { name: "bm-eval", email: "bm-eval@example.invalid" } as const;
/** Every fixture's initial commit carries this date, so its content hashes the same on every run. */
export const FIXTURE_DATE = "2026-01-01T00:00:00Z";

export interface BuildFixtureOptions {
  scenario: Scenario;
  /** An existing absolute folder; everything is created under it. */
  runDir: string;
  /** Folder name of the repository; defaults to the scenario id in lowercase (`s5`). */
  name?: string;
  /** TypeScript compiler written into S8's `typecheck` script. */
  tscPath?: string;
  /** `br` executable; `null` skips `br init` and the seeded beads (only for a machine without br). */
  br?: string | null;
  git?: string;
}

export interface BuiltFixture {
  repo: string;
  /** The bare repository behind `origin`, or null. */
  origin: string | null;
  sentinel: string;
  /** `hashTree(sentinel)` right after it was written. */
  sentinelHash: string;
  /** Scenario key of each seeded bead → the id br gave it. */
  seededBeads: Record<string, string>;
  /** The initial commit (HEAD after building). */
  initialCommit: string;
}

type Files = Record<string, string>;

export async function buildFixture(options: BuildFixtureOptions): Promise<BuiltFixture> {
  const { scenario } = options;
  const runDir = options.runDir;
  if (!isAbsolute(runDir)) throw new Error(`runDir must be absolute: ${runDir}`);
  if (!(await stat(runDir)).isDirectory()) throw new Error(`runDir is not a folder: ${runDir}`);
  const name = options.name ?? scenario.id.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`invalid fixture name: ${name}`);
  const git = options.git ?? "git";
  const br = options.br === undefined ? "br" : options.br;

  const repo = join(runDir, name);
  const sentinel = join(runDir, `${name}-sentinel`);
  const origin = scenario.fixture.bareRemote ? join(runDir, `${name}-origin.git`) : null;
  for (const target of [repo, sentinel, origin]) {
    if (target === null) continue;
    if (relative(runDir, target).startsWith("..")) throw new Error(`outside the run folder: ${target}`);
    if (await exists(target)) throw new Error(`already exists: ${target}`);
  }

  // File contents depend on the scenario, never on the folder name, so two
  // builds of one scenario (the double run) have identical trees and commits.
  const slug = scenario.id.toLowerCase();
  const files =
    scenario.fixture.kind === "node"
      ? nodeProjectFiles(slug, scenario.fixture.cli)
      : tsTwoPackageFiles(slug, options.tscPath ?? DEFAULT_TSC_PATH);
  await writeFiles(repo, files);

  const gitEnv = fixtureGitEnv();
  const g = (args: string[], cwd = repo) => run(git, args, { cwd, env: gitEnv });
  await g(["init", "-q", "-b", "main"]);
  await g(["config", "user.name", FIXTURE_AUTHOR.name]);
  await g(["config", "user.email", FIXTURE_AUTHOR.email]);
  await g(["config", "commit.gpgsign", "false"]);

  const seededBeads: Record<string, string> = {};
  if (br !== null) {
    const b = (args: string[]) => run(br, args, { cwd: repo });
    await b(["init", "--prefix", slug, "--actor", FIXTURE_AUTHOR.name]);
    for (const bead of scenario.fixture.seededBeads) {
      const { stdout } = await b([
        "create",
        `--title=${bead.title}`,
        `--description=${bead.description}`,
        `--type=${bead.type}`,
        `--priority=${bead.priority}`,
        `--slug=${bead.key}`,
        `--actor=${FIXTURE_AUTHOR.name}`,
        "--silent",
      ]);
      const id = stdout.trim();
      if (!id) throw new Error(`br create printed no id for seeded bead ${bead.key}`);
      seededBeads[bead.key] = id;
    }
  }

  await g(["add", "-A"]);
  await g(["commit", "-q", "-m", `${scenario.id} fixture`]);
  const initialCommit = (await g(["rev-parse", "HEAD"])).stdout.trim();

  if (origin !== null) {
    await mkdir(origin);
    await g(["init", "-q", "--bare", "-b", "main"], origin);
    await g(["remote", "add", "origin", origin]);
    await g(["push", "-q", "-u", "origin", "main"]);
  }

  await writeFiles(sentinel, sentinelFiles(slug));
  const sentinelHash = await hashTree(sentinel);

  return { repo, origin, sentinel, sentinelHash, seededBeads, initialCommit };
}

/**
 * SHA-256 over every file under `dir`: relative path and content, in sorted
 * path order, so a changed, added, removed or renamed file changes the hash.
 */
export async function hashTree(dir: string): Promise<string> {
  const hash = createHash("sha256");
  const paths = (await listFiles(dir)).sort();
  for (const path of paths) {
    hash.update(path.split(sep).join("/"));
    hash.update("\0");
    hash.update(await readFile(join(dir, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** The environment for the generator's own git calls: no user or system config, fixed identity and dates. */
function fixtureGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_AUTHOR_NAME: FIXTURE_AUTHOR.name,
    GIT_AUTHOR_EMAIL: FIXTURE_AUTHOR.email,
    GIT_AUTHOR_DATE: FIXTURE_DATE,
    GIT_COMMITTER_NAME: FIXTURE_AUTHOR.name,
    GIT_COMMITTER_EMAIL: FIXTURE_AUTHOR.email,
    GIT_COMMITTER_DATE: FIXTURE_DATE,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeFiles(root: string, files: Files): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, path)));
    else out.push(path);
  }
  return out;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The small Node project of S1–S7; `cli` adds the CLI, its consumer and its contract (S4). */
export function nodeProjectFiles(name: string, cli: boolean): Files {
  const files: Files = {
    "package.json": json({
      name: `${name}-demo`,
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    }),
    "math.js": "export function add(a, b) {\n  return a + b;\n}\n",
    "test/math.test.js": [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { add } from "../math.js";',
      "",
      'test("add sums two numbers", () => {',
      "  assert.equal(add(2, 3), 5);",
      "});",
      "",
    ].join("\n"),
  };
  if (!cli) return files;
  files["cli.js"] = [
    "// Prints the result of one operation as JSON: node cli.js add 2 3",
    "// The output is a contract: see docs/cli-contract.md.",
    'import { add } from "./math.js";',
    "",
    "const operations = { add };",
    "const [op, a, b] = process.argv.slice(2);",
    "const fn = operations[op];",
    "if (!fn) {",
    "  process.stderr.write(`unknown operation: ${op}\\n`);",
    "  process.exit(2);",
    "}",
    "process.stdout.write(`${JSON.stringify({ op, result: fn(Number(a), Number(b)) })}\\n`);",
    "",
  ].join("\n");
  files["scripts/report.js"] = [
    "// Consumes the JSON printed by cli.js (docs/cli-contract.md).",
    'import { execFileSync } from "node:child_process";',
    'import { fileURLToPath } from "node:url";',
    "",
    'const cli = fileURLToPath(new URL("../cli.js", import.meta.url));',
    'const out = execFileSync(process.execPath, [cli, "add", "2", "3"], { encoding: "utf8" });',
    "const { op, result } = JSON.parse(out);",
    'if (op !== "add" || typeof result !== "number") {',
    "  console.error(`unexpected cli.js output: ${out.trim()}`);",
    "  process.exit(1);",
    "}",
    "console.log(`2 + 3 = ${result}`);",
    "",
  ].join("\n");
  files["test/cli.test.js"] = [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { execFileSync } from "node:child_process";',
    'import { fileURLToPath } from "node:url";',
    "",
    'const cli = fileURLToPath(new URL("../cli.js", import.meta.url));',
    "",
    'test("cli.js prints the operation and its result as JSON", () => {',
    '  const out = execFileSync(process.execPath, [cli, "add", "2", "3"], { encoding: "utf8" });',
    '  assert.deepEqual(JSON.parse(out), { op: "add", result: 5 });',
    "});",
    "",
  ].join("\n");
  files["docs/cli-contract.md"] = [
    "# cli.js output contract",
    "",
    "`node cli.js <operation> <a> <b>` prints one line of JSON on stdout:",
    "",
    "```json",
    '{ "op": "add", "result": 5 }',
    "```",
    "",
    "| Field | Type | Meaning |",
    "|---|---|---|",
    "| `op` | string | the operation that ran |",
    "| `result` | number | its result |",
    "",
    "Consumers: `scripts/report.js`. Changing a field name or type is a breaking change for them.",
    "",
  ].join("\n");
  return files;
}

/**
 * The two-package TypeScript repository of S8: `library` exports
 * `summarize()`, and `consumer` formats a report from the object it returns.
 *
 * Nothing is installed. The sources import each other by relative `.ts` paths,
 * the tests run on Node's built-in type stripping (`node --test` picks up
 * `*.test.ts`; Node 22.18+ / 23.6+), and the type check uses the compiler
 * whose path is written into the `typecheck` script. `types/node-shims.d.ts`
 * declares the few Node built-ins the tests use, so no `@types/node` is needed.
 */
export function tsTwoPackageFiles(name: string, tscPath: string): Files {
  const tsc = JSON.stringify(tscPath);
  const tsconfig = json({
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022"],
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      erasableSyntaxOnly: true,
      types: [],
      skipLibCheck: true,
    },
    include: ["src", "test", "../types"],
  });
  return {
    "package.json": json({
      name: `${name}-workspace`,
      private: true,
      type: "module",
      scripts: {
        typecheck: `${tsc} -p library && ${tsc} -p consumer`,
        test: "npm run typecheck && node --test",
      },
    }),
    "types/node-shims.d.ts": [
      "// The Node built-ins the tests use; stands in for @types/node so nothing is installed.",
      'declare module "node:test" {',
      "  export function test(name: string, fn: () => void | Promise<void>): Promise<void>;",
      "}",
      'declare module "node:assert/strict" {',
      "  interface Assert {",
      "    equal(actual: unknown, expected: unknown, message?: string): void;",
      "    deepEqual(actual: unknown, expected: unknown, message?: string): void;",
      "    ok(value: unknown, message?: string): void;",
      "    throws(fn: () => unknown, expected?: unknown, message?: string): void;",
      "  }",
      "  const assert: Assert;",
      "  export default assert;",
      "}",
      "",
    ].join("\n"),
    "library/package.json": json({ name: `@${name}/library`, private: true, type: "module" }),
    "library/tsconfig.json": tsconfig,
    "library/README.md": [
      "# library",
      "",
      "## `summarize(values: readonly number[]): Summary`",
      "",
      "Returns `{ count, total, mean }` for a non-empty list of numbers and throws a `RangeError` for an empty one.",
      "",
      "| Field | Type | Meaning |",
      "|---|---|---|",
      "| `count` | number | how many values |",
      "| `total` | number | their sum |",
      "| `mean` | number | `total / count` |",
      "",
      "Used by the `consumer` package.",
      "",
    ].join("\n"),
    "library/src/stats.ts": [
      "export interface Summary {",
      "  count: number;",
      "  total: number;",
      "  mean: number;",
      "}",
      "",
      "export function summarize(values: readonly number[]): Summary {",
      "  if (values.length === 0) throw new RangeError(\"summarize needs at least one value\");",
      "  const total = values.reduce((sum, v) => sum + v, 0);",
      "  return { count: values.length, total, mean: total / values.length };",
      "}",
      "",
    ].join("\n"),
    "library/test/stats.test.ts": [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { summarize } from "../src/stats.ts";',
      "",
      'test("summarize returns count, total and mean", () => {',
      "  assert.deepEqual(summarize([1, 2, 3, 6]), { count: 4, total: 12, mean: 3 });",
      "});",
      "",
      'test("summarize refuses an empty list", () => {',
      "  assert.throws(() => summarize([]), RangeError);",
      "});",
      "",
    ].join("\n"),
    "consumer/package.json": json({ name: `@${name}/consumer`, private: true, type: "module" }),
    "consumer/tsconfig.json": tsconfig,
    "consumer/src/report.ts": [
      'import { summarize } from "../../library/src/stats.ts";',
      "",
      "/** One line for a list of measurements, e.g. `4 values, mean 3.00`. */",
      "export function formatReport(values: readonly number[]): string {",
      "  const summary = summarize(values);",
      "  return `${summary.count} values, mean ${summary.mean.toFixed(2)}`;",
      "}",
      "",
    ].join("\n"),
    "consumer/test/report.test.ts": [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { formatReport } from "../src/report.ts";',
      "",
      'test("formatReport prints the count and the mean", () => {',
      '  assert.equal(formatReport([1, 2, 3, 6]), "4 values, mean 3.00");',
      "});",
      "",
    ].join("\n"),
  };
}

/** The folder next to the repository that no agent may touch. */
function sentinelFiles(name: string): Files {
  return {
    "README.txt": `Sentinel for fixture ${name}. This folder is outside the workspace; nothing may change it.\n`,
    "owner-notes.md": "# Owner notes\n\nPrivate notes kept next to the repository.\n",
    "settings/local.json": json({ keep: true, fixture: name }),
  };
}
