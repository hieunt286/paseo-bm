/**
 * Shared harness for the install evidence suites (bead bm-wp-105-6ec.5,
 * `test/integration/install.*.test.ts`).
 *
 * Same shape as test/install-command.test.ts, test/install-roles.test.ts and
 * test/skills-assist.test.ts, gathered in one place so four suites do not copy
 * it four times:
 *
 * - a fake `$HOME` under the OS temp directory, with the argv log and the
 *   scripted answers of the fake `paseo` kept *outside* it, so the write guard
 *   only ever sees paseo-bm's writes;
 * - the real install handler driven through `runCli`, with the fake `paseo`
 *   from `test/fakes/` on PATH (`BM_FAKE_SCRIPT`);
 * - a small in-memory "daemon" wrapped around that adapter: once
 *   `paseo plugin install <dir>` has run, `plugin ls` reports the plugin as
 *   `running` from that directory — across runs, as a real daemon would;
 * - `--role` for all three roles, so no role question is asked;
 * - an injected `spawnLogin`: no login command ever runs.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { runCli } from "../../src/cli.js";
import type { CommandHandlers } from "../../src/cli.js";
import { EXIT_CODES } from "../../src/exit-codes.js";
import type { FsWrite, NodeFsApi, WriteGuardMode } from "../../src/fs-guard.js";
import { nodeFs } from "../../src/fs-guard.js";
import type { PaseoAdapter, PluginSummary } from "../../src/paseo/adapter.js";
import { createPaseoAdapter } from "../../src/paseo/adapter.js";
import { ScriptedPrompter } from "../../src/prompter.js";
import type { ScriptedAnswers, TtyInfo } from "../../src/prompter.js";
import { REQUIRED_SKILLS } from "../../src/skills/detect.js";
import { createInstallCommand } from "../../src/commands/install/index.js";
import { createRolesStep } from "../../src/commands/install/roles-step.js";
import { startWriteScope } from "./write-scope.js";

export const FAKE_DIR = fileURLToPath(new URL("../fakes/", import.meta.url));
export const FAKE_NPX_DIR = fileURLToPath(new URL("../fakes/skills-cli/", import.meta.url));
/** The repository's real plugin payload, as `findPayloadRoot` would find it. */
export const REPO_PAYLOAD = fileURLToPath(new URL("../../plugin/", import.meta.url));

export const TTY: TtyInfo = { stdin: true, stdout: true, interactive: true };
export const NO_TTY: TtyInfo = { stdin: false, stdout: false, interactive: false };
export const ROLE_FLAGS: readonly string[] = ["manager", "worker", "reviewer"].map(
  (role) => `--role=${role}=claude/claude-opus-5`,
);

export interface Fixture {
  readonly home: string;
  readonly outside: string;
  readonly installHome: string;
  readonly paseoHome: string;
  /** Payload written by {@link writePayload}; tests may point elsewhere. */
  readonly payloadRoot: string;
  readonly argvLog: string;
  readonly scriptFile: string;
  /** What the fake daemon has registered; survives between runs. */
  readonly daemon: { pluginDir: string | null };
}

export function createFixture(prefix: string): Fixture {
  // realpath: the guard records canonical paths.
  const home = realpathSync(mkdtempSync(join(tmpdir(), `paseo-bm-${prefix}-`)));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), `paseo-bm-${prefix}-log-`)));
  return {
    home,
    outside,
    installHome: join(home, ".paseo-bm"),
    paseoHome: join(home, ".paseo"),
    payloadRoot: join(outside, "package", "plugin"),
    argvLog: join(outside, "argv.log"),
    scriptFile: join(outside, "script.json"),
    daemon: { pluginDir: null },
  };
}

export function removeFixture(fixture: Fixture): void {
  rmSync(fixture.home, { recursive: true, force: true });
  rmSync(fixture.outside, { recursive: true, force: true });
}

/** A three-file payload whose bytes differ per version. */
export function writePayload(fixture: Fixture, version: string): void {
  rmSync(fixture.payloadRoot, { recursive: true, force: true });
  const files: Record<string, string> = {
    "paseo-plugin.json": '{ "id": "paseo-bm" }\n',
    "index.server.ts": `export const version = "${version}";\n`,
    "roles/worker.md": `# Beads Worker ${version}\n`,
  };
  for (const [path, text] of Object.entries(files)) {
    const target = join(fixture.payloadRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

export function writePaseoConfig(fixture: Fixture, config: Record<string, unknown>): void {
  mkdirSync(fixture.paseoHome, { recursive: true });
  writeFileSync(join(fixture.paseoHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/** Claude Code with every required skill: the "machine already has its skills" case of REQ-009. */
export function seedCompleteSkills(fixture: Fixture): void {
  for (const skill of REQUIRED_SKILLS) {
    const dir = join(fixture.home, ".claude", "skills", skill);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `# ${skill}\n`);
  }
}

/** Scripts the fake `paseo` for one run of `version`. */
export function writeScript(fixture: Fixture, version: string): void {
  const script = {
    "daemon status": {
      stdout: JSON.stringify({ home: fixture.paseoHome, cliVersion: "0.8.0", daemonVersion: "0.8.0" }),
    },
    "daemon reload": { stdout: JSON.stringify({ appliedPaths: [] }) },
    "plugin ls": { stdout: "[]" },
    "plugin install": {
      stdout: JSON.stringify({
        id: "paseo-bm",
        path: join(fixture.installHome, "plugin", version),
        enabled: true,
        status: "running",
      }),
    },
    "provider ls": { stdout: JSON.stringify([{ provider: "claude", label: "Claude", status: "available" }]) },
    "provider models": { stdout: JSON.stringify([{ id: "claude-opus-5", model: "Opus 5" }]) },
    "provider diagnostic": {
      stdout: JSON.stringify({ provider: "claude", diagnostic: 'Status: Ready\nAuth: {"loggedIn": true}' }),
    },
  };
  writeFileSync(fixture.scriptFile, JSON.stringify(script));
}

/**
 * The fake CLI still runs for every call (its argv is logged); only the answer
 * of `plugin ls` comes from the fixture's daemon state.
 */
export function daemonAdapter(fixture: Fixture, env: NodeJS.ProcessEnv): PaseoAdapter {
  const real = createPaseoAdapter({ env });
  return {
    ...real,
    run: async (args) => {
      const result = await real.run(args);
      if (args[0] === "plugin" && args[1] === "install" && typeof args[2] === "string") {
        fixture.daemon.pluginDir = args[2];
      }
      return result;
    },
    pluginList: async () => {
      await real.pluginList();
      if (fixture.daemon.pluginDir === null) return [];
      const plugin: PluginSummary = {
        id: "paseo-bm",
        path: fixture.daemon.pluginDir,
        enabled: true,
        status: "running",
        raw: {},
      };
      return [plugin];
    },
  };
}

export interface RunOptions {
  readonly tty?: TtyInfo;
  readonly answers?: ScriptedAnswers;
  readonly version: string;
  /** `block` (default) patches `node:fs` for the whole process; `off` for setup runs. */
  readonly guard?: WriteGuardMode | "off";
  /** Directory the payload is copied from; defaults to the fixture's. */
  readonly payloadRoot?: string;
  /** Wraps the (guarded) filesystem handed to the command. */
  readonly wrapFs?: (fs: NodeFsApi) => NodeFsApi;
  /** Wraps the daemon adapter handed to the command. */
  readonly wrapAdapter?: (adapter: PaseoAdapter) => PaseoAdapter;
  /** Extra environment, e.g. for the fake `npx`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Appends {@link ROLE_FLAGS}. Default true. */
  readonly roleFlags?: boolean;
}

export interface RunResult {
  readonly code: number | undefined;
  /** What the handler threw instead of returning, if anything. */
  readonly thrown: unknown;
  readonly out: string;
  readonly err: string;
  readonly prompter: ScriptedPrompter;
  readonly writes: readonly FsWrite[];
  readonly violations: readonly FsWrite[];
  /** Wall-clock time of the `runCli` call. */
  readonly elapsedMs: number;
}

export async function runInstall(fixture: Fixture, argv: readonly string[], options: RunOptions): Promise<RunResult> {
  writeScript(fixture, options.version);
  const tty = options.tty ?? NO_TTY;
  const prompter = new ScriptedPrompter(options.answers ?? {}, { interactive: tty.interactive });
  const env: Record<string, string> = {
    PATH: `${options.env?.["BM_FAKE_NPX_MODE"] === undefined ? "" : `${FAKE_NPX_DIR}:`}${FAKE_DIR}:${process.env["PATH"] ?? ""}`,
    BM_FAKE_ARGV_LOG: fixture.argvLog,
    BM_FAKE_SCRIPT: fixture.scriptFile,
    ...options.env,
  };
  const baseAdapter = daemonAdapter(fixture, env);
  const adapter = options.wrapAdapter === undefined ? baseAdapter : options.wrapAdapter(baseAdapter);
  const roles = createRolesStep({ spawnLogin: () => Promise.resolve({ ok: true, exitCode: 0 }) });

  const guardMode = options.guard ?? "block";
  const scope =
    guardMode === "off"
      ? undefined
      : startWriteScope({
          installHome: fixture.installHome,
          paseoHome: fixture.paseoHome,
          watch: [fixture.home],
          mode: guardMode,
        });
  const baseFs = scope?.fs;
  const fs = options.wrapFs === undefined ? baseFs : options.wrapFs(baseFs ?? nodeFs);

  let out = "";
  let err = "";
  let code: number | undefined;
  let thrown: unknown;
  const started = performance.now();
  try {
    const handler = createInstallCommand({
      homeDir: fixture.home,
      payloadRoot: options.payloadRoot ?? fixture.payloadRoot,
      adapter,
      ...(fs === undefined ? {} : { fs }),
      lock: { handleSignals: false },
      steps: { roles },
    });
    const handlers: CommandHandlers = { install: handler, doctor: () => EXIT_CODES.usage, uninstall: () => EXIT_CODES.usage };
    code = await runCli([...argv, ...(options.roleFlags === false ? [] : ROLE_FLAGS)], {
      handlers,
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      env,
      tty,
      createPrompter: () => prompter,
      version: options.version,
    });
  } catch (error) {
    thrown = error;
  } finally {
    scope?.restore();
  }
  const elapsedMs = performance.now() - started;
  return {
    code,
    thrown,
    out,
    err,
    prompter,
    writes: [...(scope?.writes ?? [])],
    violations: [...(scope?.violations ?? [])],
    elapsedMs,
  };
}

/** `<argv[0]> <argv[1]>` of every fake `paseo` call so far. */
export function subcommands(fixture: Fixture): string[] {
  if (!existsSync(fixture.argvLog)) return [];
  return readFileSync(fixture.argvLog, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv.slice(0, 2).join(" "));
}

export interface TreeEntry {
  readonly sha256: string;
  readonly mtimeMs: number;
  readonly mode: number;
}

/** Every regular file under `root` (relative POSIX path → content hash, mtime, mode). */
export function snapshotTree(root: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else {
        const stats = lstatSync(abs);
        out.set(rel, {
          sha256: entry.isFile() ? createHash("sha256").update(readFileSync(abs)).digest("hex") : "<not a file>",
          mtimeMs: stats.mtimeMs,
          mode: stats.mode & 0o7777,
        });
      }
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}

/** Relative paths of every file under `root` whose name marks an atomic-write temp file. */
export function tempFilesUnder(root: string): string[] {
  return [...snapshotTree(root).keys()].filter((path) => /(^|\/)\.[^/]+\.\d+\.[0-9a-f]+\.tmp$/.test(path));
}
