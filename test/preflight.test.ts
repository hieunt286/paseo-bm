import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Preflight is the gate every write stands behind, so these tests have to prove
 * two things for every failing branch: the right diagnosis (exit code 3 with a
 * remediation the user can act on), and that **nothing was written**.
 *
 * The second claim is made by a recording interceptor installed over `node:fs`
 * and `node:fs/promises` below. Every mutating call is appended to a log and
 * then forwarded to the real implementation, so behaviour is unchanged and the
 * assertion is simply "the log is empty". The log is cleared immediately before
 * the call under test, so the test's own scaffolding (temp dirs, `chmod`) is
 * never confused with a write made by preflight.
 *
 * `src/fs-guard.ts` provides the *scope* guard for code that takes an injected
 * `NodeFsApi`; preflight injects nothing because it never writes, so a
 * process-level interceptor is the form of proof that fits here. When
 * `test/helpers/write-scope.ts` lands, this local interceptor can be replaced
 * by it without changing a single assertion below.
 *
 * No test here runs a real `paseo`: the CLI is either the fake in `test/fakes/`
 * or an in-memory adapter, and `~/.paseo` is never read or written.
 */

const guard = vi.hoisted(() => {
  const calls: string[] = [];

  /** Members of `node:fs` that change something on disk. */
  const SYNC_WRITERS = [
    "appendFileSync", "chmodSync", "chownSync", "copyFileSync", "cpSync", "createWriteStream",
    "fchmodSync", "fchownSync", "ftruncateSync", "futimesSync", "lchownSync", "linkSync",
    "lutimesSync", "mkdirSync", "mkdtempSync", "renameSync", "rmSync", "rmdirSync",
    "symlinkSync", "truncateSync", "unlinkSync", "utimesSync", "writeFileSync", "writeSync",
    "writevSync",
    // Callback forms of the same operations.
    "appendFile", "chmod", "chown", "copyFile", "cp", "link", "mkdir", "mkdtemp", "rename",
    "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "write", "writeFile", "writev",
  ];

  /** Members of `node:fs/promises` that change something on disk. */
  const PROMISE_WRITERS = [
    "appendFile", "chmod", "chown", "copyFile", "cp", "link", "mkdir", "mkdtemp", "open",
    "rename", "rm", "rmdir", "symlink", "truncate", "unlink", "utimes", "writeFile",
  ];

  /**
   * Copy a module namespace, replacing each named member with a wrapper that
   * records the call and then delegates. Nothing is blocked: a test that needs
   * to create its own fixture still can.
   */
  const wrap = (actual: Record<string, unknown>, label: string, names: readonly string[]): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...actual };
    for (const name of names) {
      if (typeof actual[name] !== "function") continue;
      copy[name] = function recorded(this: unknown, ...args: unknown[]): unknown {
        const target = typeof args[0] === "string" ? args[0] : "";
        calls.push(`${label}.${name}(${target})`);
        // Looked up at call time, not captured: `test/helpers/write-scope.ts`
        // patches these namespaces while it is active, and this recorder has to
        // delegate *through* that patch rather than around it.
        return (actual[name] as (...inner: unknown[]) => unknown).apply(this, args);
      };
    }
    copy["default"] = copy;
    return copy;
  };

  return { calls, SYNC_WRITERS, PROMISE_WRITERS, wrap };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return guard.wrap(actual, "fs", guard.SYNC_WRITERS);
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return guard.wrap(actual, "fs.promises", guard.PROMISE_WRITERS);
});

import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BEADS_CLI_NAMES,
  MINIMUM_NODE_MAJOR,
  MINIMUM_PASEO_VERSION,
  PREFLIGHT_EXIT_CODE,
  checkBeadsCli,
  checkInstallHomeWritable,
  checkNodeVersion,
  checkOperatingSystem,
  checkPaseoVersion,
  compareVersions,
  findExecutableOnPath,
  formatPreflightFailure,
  meetsMinimumPaseoVersion,
  nearestExistingAncestor,
  parseVersion,
  realFsProbe,
  runPreflight,
} from "../src/preflight.js";
import type { PreflightCheckId, PreflightResult } from "../src/preflight.js";
import { DIAGNOSTICS, diagnostic } from "../src/errors.js";
import type { DiagnosticCode } from "../src/errors.js";
import { EXIT_CODES } from "../src/exit-codes.js";
import { createPaseoAdapter } from "../src/paseo/adapter.js";
import { withWriteScope } from "./helpers/write-scope.js";
import type { DaemonStatus, PaseoAdapter } from "../src/paseo/adapter.js";

const FAKE_DIR = fileURLToPath(new URL("./fakes/", import.meta.url));
const FAKE_PASEO = join(FAKE_DIR, "paseo");

const temporaryDirs: string[] = [];

interface Sandbox {
  /** Stand-in for `$HOME`; nothing in these tests may change anything under it. */
  readonly root: string;
  /** Install home that does not exist yet — the normal first-run shape. */
  readonly installHome: string;
  /** A directory with no executables in it, so PATH lookups are deterministic. */
  readonly emptyBin: string;
  readonly paseoHome: string;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "paseo-bm-preflight-"));
  temporaryDirs.push(root);
  const emptyBin = join(root, "bin");
  const paseoHome = join(root, ".paseo");
  mkdirSync(emptyBin, { recursive: true });
  mkdirSync(paseoHome, { recursive: true });
  return { root, installHome: join(root, ".paseo-bm"), emptyBin, paseoHome };
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir === undefined) continue;
    // A read-only fixture directory has to be made writable again to be removed.
    try {
      chmodSync(dir, 0o755);
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  guard.calls.length = 0;
});

/** Environment for the fake CLI: the fake needs `node`, nothing else. */
function fakeEnv(script: { stdout?: string; exit?: number; stderr?: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: `${FAKE_DIR}:${process.env["PATH"] ?? ""}` };
  if (script.stdout !== undefined) env["BM_FAKE_STDOUT"] = script.stdout;
  if (script.stderr !== undefined) env["BM_FAKE_STDERR"] = script.stderr;
  if (script.exit !== undefined) env["BM_FAKE_EXIT"] = String(script.exit);
  return env;
}

/** Adapter wired to the fake CLI, scripted to answer `daemon status`. */
function healthyAdapter(sandbox: Sandbox, versions: { cli: string; daemon: string }): PaseoAdapter {
  return createPaseoAdapter({
    executable: FAKE_PASEO,
    timeoutMs: 5_000,
    env: fakeEnv({
      stdout: JSON.stringify({
        home: sandbox.paseoHome,
        cliVersion: versions.cli,
        daemonVersion: versions.daemon,
        listen: "127.0.0.1:7777",
      }),
    }),
  });
}

/** Adapter pointed at a path where no CLI exists: ENOENT, i.e. "not installed". */
function missingCliAdapter(sandbox: Sandbox): PaseoAdapter {
  return createPaseoAdapter({
    executable: join(sandbox.root, "no-such-paseo"),
    timeoutMs: 5_000,
    env: fakeEnv({}),
  });
}

/** Adapter whose CLI exits non-zero, the shape of "the daemon is not running". */
function daemonDownAdapter(): PaseoAdapter {
  return createPaseoAdapter({
    executable: FAKE_PASEO,
    timeoutMs: 5_000,
    env: fakeEnv({ exit: 1, stderr: "error: could not connect to the Paseo daemon\n" }),
  });
}

/** In-memory adapter that counts calls, for branches that must stop before Paseo. */
function countingAdapter(): { adapter: PaseoAdapter; calls: string[] } {
  const calls: string[] = [];
  const reject = (name: string) => async (): Promise<never> => {
    calls.push(name);
    throw new Error(`preflight reached \`${name}\` when it should not have`);
  };
  const adapter = {
    executable: "paseo",
    timeoutMs: 15_000,
    run: reject("run"),
    daemonStatus: reject("daemonStatus"),
    daemonReload: reject("daemonReload"),
    pluginInstall: reject("pluginInstall"),
    pluginList: reject("pluginList"),
    pluginLogs: reject("pluginLogs"),
    pluginRemove: reject("pluginRemove"),
  } as unknown as PaseoAdapter;
  return { adapter, calls };
}

/** Recursive listing with the facts that change when something is written. */
function snapshot(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, item.name);
      const stats = statSync(full);
      entries.push(`${full}|${item.isDirectory() ? "dir" : "file"}|${stats.size}|${stats.mtimeMs}|${stats.mode}`);
      if (item.isDirectory()) walk(full);
    }
  };
  walk(root);
  return entries;
}

/** Run something with the write log cleared, and report every write it made. */
async function withWriteLog<T>(run: () => Promise<T>): Promise<{ value: T; writes: string[] }> {
  guard.calls.length = 0;
  const value = await run();
  return { value, writes: [...guard.calls] };
}

describe("write-log interceptor", () => {
  it("sees a write that really happens, so an empty log means something", async () => {
    const sandbox = makeSandbox();
    const { writes } = await withWriteLog(async () => {
      writeFileSync(join(sandbox.root, "canary.txt"), "x");
    });
    expect(writes).toContain(`fs.writeFileSync(${join(sandbox.root, "canary.txt")})`);
  });
});

describe("runPreflight — every failing branch stops before the first write", () => {
  interface Row {
    readonly name: string;
    readonly checkId: PreflightCheckId;
    readonly code: DiagnosticCode;
    /** Build the options; may prepare fixtures first. */
    readonly build: (sandbox: Sandbox) => {
      options: Parameters<typeof runPreflight>[0];
      /** Paseo must not be contacted at all on this branch. */
      noDaemonCall?: string[];
    };
    readonly skip?: () => boolean;
  }

  const rows: readonly Row[] = [
    {
      name: "unsupported operating system",
      checkId: "operating-system",
      code: "E_UNSUPPORTED_OS",
      build: (sandbox) => {
        const counting = countingAdapter();
        return {
          options: {
            adapter: counting.adapter,
            installHome: sandbox.installHome,
            platform: "win32",
            nodeVersion: "24.0.0",
            env: { PATH: sandbox.emptyBin },
          },
          noDaemonCall: counting.calls,
        };
      },
    },
    {
      name: "Node.js older than the floor",
      checkId: "node-version",
      code: "E_NODE_TOO_OLD",
      build: (sandbox) => {
        const counting = countingAdapter();
        return {
          options: {
            adapter: counting.adapter,
            installHome: sandbox.installHome,
            platform: "linux",
            nodeVersion: "20.11.1",
            env: { PATH: sandbox.emptyBin },
          },
          noDaemonCall: counting.calls,
        };
      },
    },
    {
      name: "the paseo CLI is not installed",
      checkId: "paseo-cli",
      code: "E_PASEO_CLI_MISSING",
      build: (sandbox) => ({
        options: {
          adapter: missingCliAdapter(sandbox),
          installHome: sandbox.installHome,
          platform: "linux",
          nodeVersion: "24.0.0",
          env: { PATH: sandbox.emptyBin },
        },
      }),
    },
    {
      name: "the daemon is not running",
      checkId: "paseo-daemon",
      code: "E_DAEMON_UNREACHABLE",
      build: (sandbox) => ({
        options: {
          adapter: daemonDownAdapter(),
          installHome: sandbox.installHome,
          platform: "linux",
          nodeVersion: "24.0.0",
          env: { PATH: sandbox.emptyBin },
        },
      }),
    },
    {
      name: "the CLI and the daemon report different versions",
      checkId: "paseo-version",
      code: "E_VERSION_MISMATCH",
      build: (sandbox) => ({
        options: {
          adapter: healthyAdapter(sandbox, { cli: "0.9.1", daemon: "0.9.2" }),
          installHome: sandbox.installHome,
          platform: "linux",
          nodeVersion: "24.0.0",
          env: { PATH: sandbox.emptyBin },
        },
      }),
    },
    {
      name: "Paseo is older than 0.9.0",
      checkId: "paseo-version",
      code: "E_VERSION_MISMATCH",
      build: (sandbox) => ({
        options: {
          adapter: healthyAdapter(sandbox, { cli: "0.8.0", daemon: "0.8.0" }),
          installHome: sandbox.installHome,
          platform: "linux",
          nodeVersion: "24.0.0",
          env: { PATH: sandbox.emptyBin },
        },
      }),
    },
    {
      name: "the install home cannot be created",
      checkId: "install-home",
      code: "E_TARGET_NOT_WRITABLE",
      // Permission bits mean nothing to root, which can write anywhere.
      skip: () => process.getuid?.() === 0,
      build: (sandbox) => {
        const locked = join(sandbox.root, "locked");
        mkdirSync(locked, { recursive: true });
        chmodSync(locked, 0o500);
        temporaryDirs.push(locked);
        return {
          options: {
            adapter: healthyAdapter(sandbox, { cli: "0.9.2", daemon: "0.9.2" }),
            installHome: join(locked, "paseo-bm"),
            platform: "linux",
            nodeVersion: "24.0.0",
            env: { PATH: sandbox.emptyBin },
          },
        };
      },
    },
  ];

  for (const row of rows) {
    const runner = row.skip?.() === true ? it.skip : it;
    runner(`${row.name} -> exit ${String(EXIT_CODES.preflight)}, ${row.code}, zero writes`, async () => {
      const sandbox = makeSandbox();
      const built = row.build(sandbox);
      const before = snapshot(sandbox.root);

      const { value: result, writes } = await withWriteLog(async () => runPreflight(built.options));

      // 1. it failed, on the check it should have failed on
      expect(result.ok).toBe(false);
      expect(result.failure).not.toBeNull();
      const failure = result.failure!;
      expect(failure.checkId).toBe(row.checkId);
      expect(failure.code).toBe(row.code);

      // 2. exit code 3 — "environment precondition failed; nothing was written"
      expect(failure.exitCode).toBe(EXIT_CODES.preflight);
      expect(failure.exitCode).toBe(PREFLIGHT_EXIT_CODE);
      expect(failure.exitCode).toBe(3);

      // 3. the message carries a remediation, taken from the registry verbatim
      const entry = DIAGNOSTICS[row.code];
      expect(failure.remediation).toBe(entry.remediation);
      expect(failure.remediation.length).toBeGreaterThan(0);
      expect(failure.message.startsWith(entry.message)).toBe(true);
      expect(formatPreflightFailure(failure)).toContain(entry.remediation);

      // 4. zero writes: nothing mutated the filesystem, and nothing under the
      //    fake home changed, and the install home was not created
      expect(writes).toEqual([]);
      expect(snapshot(sandbox.root)).toEqual(before);
      expect(realFsProbe.exists(built.options.installHome)).toBe(false);

      // 5. the run stopped at that check, and the checks before it passed
      const last = result.findings.at(-1);
      expect(last?.id).toBe(row.checkId);
      expect(result.findings.filter((finding) => finding.severity === "error")).toHaveLength(1);
      if (built.noDaemonCall !== undefined) {
        expect(built.noDaemonCall).toEqual([]);
      }
    });
  }
});

describe("runPreflight — a healthy environment", () => {
  it("passes, takes the Paseo home from the daemon, and writes nothing", async () => {
    const sandbox = makeSandbox();
    const adapter = healthyAdapter(sandbox, { cli: "0.9.2", daemon: "0.9.2" });
    const before = snapshot(sandbox.root);

    const { value: result, writes } = await withWriteLog(async () =>
      runPreflight({
        adapter,
        installHome: sandbox.installHome,
        platform: "linux",
        nodeVersion: "24.0.0",
        env: { PATH: sandbox.emptyBin },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.failure).toBeNull();
    expect(writes).toEqual([]);
    expect(snapshot(sandbox.root)).toEqual(before);
    expect(realFsProbe.exists(sandbox.installHome)).toBe(false);

    // The daemon's own answer is the source of truth for Paseo's home.
    expect(result.facts.paseoHome).toBe(sandbox.paseoHome);
    expect(result.facts.cliVersion).toBe("0.9.2");
    expect(result.facts.daemonVersion).toBe("0.9.2");
    expect((result.facts.daemonStatus as DaemonStatus).listen).toBe("127.0.0.1:7777");

    expect(result.findings.map((finding) => finding.id)).toEqual([
      "operating-system",
      "node-version",
      "paseo-daemon",
      "paseo-version",
      "install-home",
      "beads-cli",
      "beads-viewer",
    ]);
  });

  it("warns but does not block when the beads CLI is missing", async () => {
    const sandbox = makeSandbox();
    const result = await runPreflight({
      adapter: healthyAdapter(sandbox, { cli: "0.9.2", daemon: "0.9.2" }),
      installHome: sandbox.installHome,
      platform: "linux",
      nodeVersion: "24.0.0",
      env: { PATH: sandbox.emptyBin },
    });

    expect(result.ok).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.warnings).toEqual([{ code: "W_BEADS_CLI_MISSING" }, { code: "W_BEADS_VIEWER_MISSING" }]);
    const beads = result.findings.find((finding) => finding.id === "beads-cli");
    expect(beads?.severity).toBe("warn");
    expect(beads?.remediation).toBe(diagnostic("W_BEADS_CLI_MISSING").remediation);
    expect(result.findings.find((finding) => finding.id === "beads-viewer")?.remediation).toBe(
      diagnostic("W_BEADS_VIEWER_MISSING").remediation,
    );
  });

  it("reports no warning when `br` and `bv` are on PATH", async () => {
    const sandbox = makeSandbox();
    const br = join(sandbox.emptyBin, "br");
    for (const tool of [br, join(sandbox.emptyBin, "bv")]) {
      writeFileSync(tool, "#!/bin/sh\nexit 0\n");
      chmodSync(tool, 0o755);
    }

    const result = await runPreflight({
      adapter: healthyAdapter(sandbox, { cli: "0.9.2", daemon: "0.9.2" }),
      installHome: sandbox.installHome,
      platform: "linux",
      nodeVersion: "24.0.0",
      env: { PATH: sandbox.emptyBin },
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.facts.beadsCli).toBe(br);
  });

  it("accepts an install home that already exists and is writable", async () => {
    const sandbox = makeSandbox();
    mkdirSync(sandbox.installHome, { recursive: true });

    const { value: result, writes } = await withWriteLog(async () =>
      runPreflight({
        adapter: healthyAdapter(sandbox, { cli: "0.9.2", daemon: "0.9.2" }),
        installHome: sandbox.installHome,
        platform: "linux",
        nodeVersion: "24.0.0",
        env: { PATH: sandbox.emptyBin },
      }),
    );

    expect(result.ok).toBe(true);
    expect(writes).toEqual([]);
  });

  it("treats unexpected daemon JSON as a preflight failure, not as a usable answer", async () => {
    const sandbox = makeSandbox();
    const adapter = createPaseoAdapter({
      executable: FAKE_PASEO,
      timeoutMs: 5_000,
      env: fakeEnv({ stdout: JSON.stringify({ home: sandbox.paseoHome }) }),
    });

    const { value: result, writes } = await withWriteLog(async () =>
      runPreflight({
        adapter,
        installHome: sandbox.installHome,
        platform: "linux",
        nodeVersion: "24.0.0",
        env: { PATH: sandbox.emptyBin },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe("E_PASEO_OUTPUT_UNEXPECTED");
    expect(result.failure?.exitCode).toBe(EXIT_CODES.preflight);
    expect(result.failure?.remediation).toBe(diagnostic("E_PASEO_OUTPUT_UNEXPECTED").remediation);
    expect(writes).toEqual([]);
    expect(result.facts.paseoHome).toBeNull();
  });
});

describe("the repo's write-scope harness agrees", () => {
  /**
   * `test/helpers/write-scope.ts` is the shared, blocking guard the install
   * command's tests use. Preflight has to be clean under it too: not one write,
   * in scope or out, on the success path or on a failing one.
   */
  it.each([
    ["a healthy environment", "ok"],
    ["a daemon that is not running", "fail"],
  ] as const)("records zero writes for %s", async (_label, expected) => {
    const sandbox = makeSandbox();
    const adapter =
      expected === "ok" ? healthyAdapter(sandbox, { cli: "0.9.2", daemon: "0.9.2" }) : daemonDownAdapter();

    const result = await withWriteScope(
      {
        installHome: sandbox.installHome,
        paseoHome: sandbox.paseoHome,
        watch: [sandbox.root],
      },
      async (scope) => {
        const value = await runPreflight({
          adapter,
          installHome: sandbox.installHome,
          platform: "linux",
          nodeVersion: "24.0.0",
          env: { PATH: sandbox.emptyBin },
        });
        expect(scope.writes).toHaveLength(0);
        expect(scope.violations).toHaveLength(0);
        return value;
      },
    );

    expect(result.ok).toBe(expected === "ok");
    if (expected === "fail") {
      expect(result.failure?.exitCode).toBe(EXIT_CODES.preflight);
    }
  });
});

describe("checkOperatingSystem", () => {
  it.each(["darwin", "linux"] as const)("accepts %s", (platform) => {
    expect(checkOperatingSystem(platform).severity).toBe("ok");
  });

  it.each(["win32", "freebsd", "aix"] as const)("refuses %s with E_UNSUPPORTED_OS", (platform) => {
    const finding = checkOperatingSystem(platform);
    expect(finding.severity).toBe("error");
    expect(finding.code).toBe("E_UNSUPPORTED_OS");
    expect(finding.remediation).toBe(diagnostic("E_UNSUPPORTED_OS").remediation);
    expect(finding.message).toContain(platform);
  });
});

describe("checkNodeVersion", () => {
  it("accepts the floor and anything above it", () => {
    expect(checkNodeVersion(`${String(MINIMUM_NODE_MAJOR)}.0.0`).severity).toBe("ok");
    expect(checkNodeVersion("24.3.1").severity).toBe("ok");
    expect(checkNodeVersion("v22.11.0").severity).toBe("ok");
  });

  it.each(["21.9.9", "18.20.4", "not-a-version"])("refuses %s", (version) => {
    const finding = checkNodeVersion(version);
    expect(finding.severity).toBe("error");
    expect(finding.code).toBe("E_NODE_TOO_OLD");
    expect(finding.remediation).toBe(diagnostic("E_NODE_TOO_OLD").remediation);
  });

  it("agrees with the runtime this test is running on", () => {
    expect(checkNodeVersion(process.versions.node).severity).toBe("ok");
  });
});

describe("checkPaseoVersion", () => {
  it("accepts equal versions at or above the minimum", () => {
    expect(checkPaseoVersion({ cliVersion: "0.9.0", daemonVersion: "0.9.0" }).severity).toBe("ok");
    expect(checkPaseoVersion({ cliVersion: "0.9.2", daemonVersion: "0.9.2" }).severity).toBe("ok");
    expect(checkPaseoVersion({ cliVersion: "1.2.3", daemonVersion: "1.2.3" }).severity).toBe("ok");
  });

  it.each([
    ["mismatch", "0.9.0", "0.9.1"],
    // 0.4.0 needs `paseo plugin add npm:<package>`, which arrived in 0.9.
    ["Paseo 0.8, which has no npm plugin source", "0.8.0", "0.8.0"],
    ["too old", "0.7.9", "0.7.9"],
    ["prerelease of the minimum", "0.9.0-rc.1", "0.9.0-rc.1"],
    ["unreadable", "next", "next"],
  ])("refuses %s", (_label, cliVersion, daemonVersion) => {
    const finding = checkPaseoVersion({ cliVersion, daemonVersion });
    expect(finding.severity).toBe("error");
    expect(finding.code).toBe("E_VERSION_MISMATCH");
    expect(finding.remediation).toBe(diagnostic("E_VERSION_MISMATCH").remediation);
  });

  it("says which version it needs, and where a Paseo 0.8 user should stay", () => {
    const finding = checkPaseoVersion({ cliVersion: "0.8.0", daemonVersion: "0.8.0" });

    expect(finding.detail).toContain("requires Paseo 0.9.0 or newer");
    expect(finding.detail).toContain("paseo-bm@0.3.1");
  });
});

describe("version parsing", () => {
  it("reads the parts of a version", () => {
    expect(parseVersion("0.8.0")).toEqual({ major: 0, minor: 8, patch: 0, prerelease: null });
    expect(parseVersion("1.2.3-rc.1+build.5")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: "rc.1" });
    expect(parseVersion("0.8")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });

  it("orders a prerelease below the release it leads to", () => {
    const rc = parseVersion("0.8.0-rc.1")!;
    const release = parseVersion("0.8.0")!;
    expect(compareVersions(rc, release)).toBe(-1);
    expect(compareVersions(release, rc)).toBe(1);
    expect(compareVersions(release, release)).toBe(0);
  });

  it("orders prereleases by SemVer 2.0.0 §11 (bm-d3q)", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = 0; j < ordered.length; j += 1) {
        const left = parseVersion(ordered[i]!)!;
        const right = parseVersion(ordered[j]!)!;
        expect(compareVersions(left, right), `${ordered[i]} vs ${ordered[j]}`).toBe(Math.sign(i - j));
      }
    }
    const alpha0 = parseVersion("0.1.0-alpha.0")!;
    const alpha1 = parseVersion("0.1.0-alpha.1")!;
    expect(compareVersions(alpha0, alpha1)).toBe(-1);
    expect(compareVersions(alpha1, alpha0)).toBe(1);
    expect(compareVersions(parseVersion("0.1.0-alpha.9")!, parseVersion("0.1.0-alpha.10")!)).toBe(-1);
    // Build metadata never affects precedence.
    expect(compareVersions(parseVersion("1.0.0-rc.1+build.1")!, parseVersion("1.0.0-rc.1+build.2")!)).toBe(0);
  });

  it("answers the only question that matters: at least 0.9.0?", () => {
    expect(MINIMUM_PASEO_VERSION).toBe("0.9.0");
    expect(meetsMinimumPaseoVersion("0.9.0")).toBe(true);
    expect(meetsMinimumPaseoVersion("0.9.2")).toBe(true);
    expect(meetsMinimumPaseoVersion("0.10.0-rc.1")).toBe(true);
    expect(meetsMinimumPaseoVersion("1.0.0")).toBe(true);
    expect(meetsMinimumPaseoVersion("0.8.0")).toBe(false);
    expect(meetsMinimumPaseoVersion("0.7.12")).toBe(false);
    expect(meetsMinimumPaseoVersion("0.9.0-rc.1")).toBe(false);
    expect(meetsMinimumPaseoVersion("garbage")).toBe(false);
  });
});

describe("checkInstallHomeWritable", () => {
  it("accepts a home that does not exist yet under a writable parent", () => {
    const sandbox = makeSandbox();
    const finding = checkInstallHomeWritable(join(sandbox.installHome, "deeper"));
    expect(finding.severity).toBe("ok");
    expect(realFsProbe.exists(sandbox.installHome)).toBe(false);
  });

  it("refuses a file sitting where the install home should be", () => {
    const sandbox = makeSandbox();
    const asFile = join(sandbox.root, "not-a-dir");
    writeFileSync(asFile, "in the way");
    const finding = checkInstallHomeWritable(join(asFile, "paseo-bm"));
    expect(finding.severity).toBe("error");
    expect(finding.code).toBe("E_CONFLICT");
  });

  it("names the ancestor that blocked it", () => {
    const sandbox = makeSandbox();
    const probe = {
      exists: (path: string) => path === sandbox.root,
      isDirectory: () => true,
      isWritableDirectory: () => false,
      isExecutableFile: () => false,
    };
    const finding = checkInstallHomeWritable(sandbox.installHome, probe);
    expect(finding.severity).toBe("error");
    expect(finding.message).toContain(sandbox.root);
    expect(finding.message).toContain(sandbox.installHome);
  });

  it("finds the nearest existing ancestor without creating anything", () => {
    const sandbox = makeSandbox();
    const deep = join(sandbox.installHome, "a", "b", "c");
    expect(nearestExistingAncestor(deep)).toBe(sandbox.root);
    expect(realFsProbe.exists(sandbox.installHome)).toBe(false);
  });
});

describe("beads CLI detection", () => {
  it("looks for `br` first, then `bd`", () => {
    expect([...BEADS_CLI_NAMES]).toEqual(["br", "bd"]);
    const sandbox = makeSandbox();
    const bd = join(sandbox.emptyBin, "bd");
    writeFileSync(bd, "#!/bin/sh\nexit 0\n");
    chmodSync(bd, 0o755);

    const withBd = checkBeadsCli({ env: { PATH: sandbox.emptyBin } });
    expect(withBd.path).toBe(bd);

    const br = join(sandbox.emptyBin, "br");
    writeFileSync(br, "#!/bin/sh\nexit 0\n");
    chmodSync(br, 0o755);
    expect(checkBeadsCli({ env: { PATH: sandbox.emptyBin } }).path).toBe(br);
  });

  it("ignores a non-executable file with the right name", () => {
    const sandbox = makeSandbox();
    const br = join(sandbox.emptyBin, "br");
    writeFileSync(br, "not executable");
    chmodSync(br, 0o644);
    expect(findExecutableOnPath("br", { env: { PATH: sandbox.emptyBin } })).toBeNull();
  });

  it("never runs the binary it finds", async () => {
    const sandbox = makeSandbox();
    const marker = join(sandbox.root, "br-ran");
    const br = join(sandbox.emptyBin, "br");
    writeFileSync(br, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(br, 0o755);

    checkBeadsCli({ env: { PATH: sandbox.emptyBin } });
    expect(realFsProbe.exists(marker)).toBe(false);
  });

  it("is a warning, so it never carries an error severity", () => {
    const sandbox = makeSandbox();
    const { finding } = checkBeadsCli({ env: { PATH: sandbox.emptyBin } });
    expect(finding.severity).toBe("warn");
    expect(finding.code).toBe("W_BEADS_CLI_MISSING");
  });
});

describe("findings and the report model", () => {
  it("produces findings that carry exactly the six fields a caller reads", async () => {
    const sandbox = makeSandbox();
    const result: PreflightResult = await runPreflight({
      adapter: healthyAdapter(sandbox, { cli: "0.9.2", daemon: "0.9.2" }),
      installHome: sandbox.installHome,
      platform: "linux",
      nodeVersion: "24.0.0",
      env: { PATH: sandbox.emptyBin },
    });

    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect(Object.keys(finding).sort()).toEqual(["code", "detail", "id", "message", "remediation", "severity"]);
    }
  });

  it("uses only codes that are in the registry", () => {
    const sandbox = makeSandbox();
    const codes = [
      checkOperatingSystem("win32").code,
      checkNodeVersion("18.0.0").code,
      checkPaseoVersion({ cliVersion: "0.7.0", daemonVersion: "0.7.0" }).code,
      checkInstallHomeWritable(join(sandbox.root, "x"), {
        exists: () => true,
        isDirectory: () => true,
        isWritableDirectory: () => false,
        isExecutableFile: () => false,
      }).code,
      checkBeadsCli({ env: { PATH: sandbox.emptyBin } }).finding.code,
    ];
    for (const code of codes) {
      expect(code).not.toBeNull();
      expect(Object.keys(DIAGNOSTICS)).toContain(code);
    }
  });
});
