/**
 * Preflight — the gate every write in paseo-bm stands behind (REQ-002,
 * Technical Design §4.3, §6, §9.3).
 *
 * The rule this module exists to enforce: when the environment is not fit, the
 * run stops **before the first write**, exits with code 3, and prints a
 * remediation the user can act on. If preflight is wrong, every later promise
 * about "no half-written state" is worthless, so nothing here touches the
 * filesystem except to *ask* about it — `access` and `stat`, never `mkdir`,
 * never a probe file. `test/preflight.test.ts` records every mutating `fs` call
 * made during a run and fails if that list is not empty.
 *
 * What is checked, in order:
 *
 *   1. operating system   — macOS and Linux; native Windows stops here
 *   2. Node.js version    — the engines floor of package.json
 *   3. the `paseo` CLI and a daemon that answers `daemon status --json`
 *   4. versions           — CLI and daemon agree, and are >= 0.8.0
 *   5. the install home   — creatable, i.e. an existing writable ancestor
 *   6. the beads CLI      — **a warning only**; it never blocks an install
 *
 * Steps 3 and 4 are one `paseo daemon status` call: the same answer proves the
 * CLI exists, proves the daemon is up, and carries both versions plus Paseo's
 * own home — which is the source of truth for paths (ADR-004), not a guess
 * assembled from `$HOME`.
 *
 * Every failure carries a code from the registry in `src/errors.ts` and that
 * code's remediation verbatim. No wording is invented here: a user who reads
 * `E_DAEMON_UNREACHABLE` in `--json` and a user who reads the human report are
 * told the same thing.
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { Check, CheckSeverity, ReportWarning } from "./action.js";
import type { DiagnosticCode, ErrorCode } from "./errors.js";
import { diagnostic } from "./errors.js";
import { EXIT_CODES } from "./exit-codes.js";
import type { ExitCode } from "./exit-codes.js";
import { isPaseoCliError } from "./paseo/adapter.js";
import type { DaemonStatus, PaseoAdapter, PaseoFailureReason } from "./paseo/adapter.js";

/** Platforms paseo-bm supports. WSL reports `linux` and is therefore allowed. */
export const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"];

/** Node floor, kept equal to the `engines.node` field of package.json. */
export const MINIMUM_NODE_MAJOR = 22;

/** Oldest Paseo paseo-bm can drive (Technical Design §6; plugin API v0.8). */
export const MINIMUM_PASEO_VERSION = "0.8.0";

/** Executable names of the beads CLI, in the order they are looked for. */
export const BEADS_CLI_NAMES: readonly string[] = ["br", "bd"];

/** Every preflight failure exits with this code — §4.3: "nothing was written". */
export const PREFLIGHT_EXIT_CODE: ExitCode = EXIT_CODES.preflight;

/** Stable identifier of each check; `doctor` reports these ids as well. */
export type PreflightCheckId =
  | "operating-system"
  | "node-version"
  | "paseo-cli"
  | "paseo-daemon"
  | "paseo-version"
  | "install-home"
  | "beads-cli";

/**
 * One check's outcome. It is a report `Check` plus the registry code, so the
 * same value can be rendered by `doctor` and turned into a failure by
 * `install` without either side re-wording it.
 */
export interface PreflightFinding extends Check {
  readonly id: PreflightCheckId;
  /** Registry code; `null` for a check that passed. */
  readonly code: DiagnosticCode | null;
  /** Run-specific context already folded into `message`; `null` when there is none. */
  readonly detail: string | null;
}

/** A blocking failure: what stopped the run, why, and what to do about it. */
export interface PreflightFailure {
  readonly checkId: PreflightCheckId;
  readonly code: ErrorCode;
  /** Registry message, plus run-specific detail when there is any. */
  readonly message: string;
  /** Registry remediation, verbatim. */
  readonly remediation: string;
  /** Always {@link PREFLIGHT_EXIT_CODE}. Nothing has been written. */
  readonly exitCode: ExitCode;
  readonly detail: string | null;
}

/** What preflight learned. Fields are `null` when the run stopped before them. */
export interface PreflightFacts {
  readonly platform: NodeJS.Platform;
  readonly nodeVersion: string;
  /** Install home the run would write into, as an absolute path. */
  readonly installHome: string;
  /** Paseo's home **as the daemon reports it** — the source of truth. */
  readonly paseoHome: string | null;
  readonly cliVersion: string | null;
  readonly daemonVersion: string | null;
  /** Absolute path of `br` or `bd`; `null` when neither is on PATH. */
  readonly beadsCli: string | null;
  /** The whole `daemon status` answer, for `--verbose` and for later steps. */
  readonly daemonStatus: DaemonStatus | null;
}

export interface PreflightResult {
  /** True when nothing blocks writing. Warnings do not affect this. */
  readonly ok: boolean;
  readonly failure: PreflightFailure | null;
  /** Checks that actually ran, in order. A run stops at the first failure. */
  readonly findings: readonly PreflightFinding[];
  /** The same findings as the report model sees them. */
  readonly checks: readonly Check[];
  /** Warnings collected on the way; they never change the exit code. */
  readonly warnings: readonly ReportWarning[];
  readonly facts: PreflightFacts;
}

/**
 * Read-only view of the filesystem. Preflight is given questions it may ask,
 * and no way to change anything — a probe file would itself be a write.
 */
export interface FsProbe {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  /** True when the current user may create entries inside this directory. */
  isWritableDirectory(path: string): boolean;
  isExecutableFile(path: string): boolean;
}

export interface PreflightOptions {
  /**
   * Adapter over the `paseo` CLI. Required on purpose: no code path here may
   * fall back to spawning the real CLI by accident.
   */
  readonly adapter: PaseoAdapter;
  /** Directory the install would write into; `layout.installHome.path`. */
  readonly installHome: string;
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `process.versions.node`. */
  readonly nodeVersion?: string;
  /** Environment used to find the beads CLI. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Filesystem probe; defaults to a real read-only one. */
  readonly fs?: FsProbe;
  /** Skip the beads lookup entirely (it is only ever a warning). */
  readonly skipBeadsCheck?: boolean;
}

const OK_MESSAGES: Readonly<Record<PreflightCheckId, string>> = {
  "operating-system": "The operating system is supported.",
  "node-version": "The Node.js runtime meets the minimum version.",
  "paseo-cli": "The `paseo` CLI is available.",
  "paseo-daemon": "The Paseo daemon answered.",
  "paseo-version": "The Paseo CLI and daemon agree on a supported version.",
  "install-home": "The install home can be written.",
  "beads-cli": "The beads CLI is available.",
};

function ok(id: PreflightCheckId, message?: string): PreflightFinding {
  return {
    id,
    severity: "ok",
    message: message ?? OK_MESSAGES[id],
    remediation: "",
    code: null,
    detail: null,
  };
}

/**
 * Build a non-passing finding. The message and the remediation come from the
 * registry; `detail` only ever *adds* run-specific context after them.
 */
function flag(
  id: PreflightCheckId,
  code: DiagnosticCode,
  severity: Exclude<CheckSeverity, "ok">,
  detail?: string,
): PreflightFinding {
  const entry = diagnostic(code);
  return {
    id,
    severity,
    message: detail === undefined ? entry.message : `${entry.message} ${detail}`,
    remediation: entry.remediation,
    code,
    detail: detail ?? null,
  };
}

function fail(id: PreflightCheckId, code: ErrorCode, detail?: string): PreflightFinding {
  return flag(id, code, "error", detail);
}

/** Turn a blocking finding into the failure the CLI exits on. */
export function toFailure(finding: PreflightFinding): PreflightFailure {
  if (finding.severity !== "error" || finding.code === null) {
    throw new Error(`preflight finding \`${finding.id}\` is not a failure`);
  }
  return {
    checkId: finding.id,
    code: finding.code as ErrorCode,
    message: finding.message,
    remediation: finding.remediation,
    exitCode: PREFLIGHT_EXIT_CODE,
    detail: finding.detail,
  };
}

/**
 * One block of text for a human: what went wrong, then what to do about it.
 * Both halves are always present — a preflight failure without a remediation
 * is a bug, not a style choice.
 */
export function formatPreflightFailure(failure: PreflightFailure): string {
  return `${failure.message}\n${failure.remediation}`;
}

/** Drop the preflight-only fields, leaving exactly what the report model takes. */
export function toCheck(finding: PreflightFinding): Check {
  return {
    id: finding.id,
    severity: finding.severity,
    message: finding.message,
    remediation: finding.remediation,
  };
}

/* ------------------------------------------------------------------ versions */

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The `-rc.1` part, or `null` when the version is a final release. */
  readonly prerelease: string | null;
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse `major.minor.patch[-prerelease][+build]`; `null` when it is not that. */
export function parseVersion(text: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(text.trim());
  if (match === null) return null;
  const [, major, minor, patch, prerelease] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
  };
}

const NUMERIC_IDENTIFIER = /^\d+$/;

/** Orders two digit-only strings by value, without the precision limit of `Number`. */
function compareNumericIdentifiers(left: string, right: string): number {
  const a = left.replace(/^0+(?=\d)/, "");
  const b = right.replace(/^0+(?=\d)/, "");
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * SemVer 2.0.0 §11 precedence for two prerelease strings: dot-separated
 * identifiers compared left to right; digit-only identifiers by numeric value,
 * the rest by ASCII; a numeric identifier is below an alphanumeric one; when
 * every shared identifier is equal, the shorter list is lower.
 */
function comparePrereleases(left: string, right: string): number {
  const a = left.split(".");
  const b = right.split(".");
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const x = a[index] ?? "";
    const y = b[index] ?? "";
    if (x === y) continue;
    const xNumeric = NUMERIC_IDENTIFIER.test(x);
    const yNumeric = NUMERIC_IDENTIFIER.test(y);
    if (xNumeric && yNumeric) {
      const order = compareNumericIdentifiers(x, y);
      if (order !== 0) return order;
      continue;
    }
    if (xNumeric) return -1;
    if (yNumeric) return 1;
    return x < y ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * SemVer 2.0.0 §11 precedence: major, minor, patch by value; a prerelease is
 * below the release it leads to; two prereleases compare identifier by
 * identifier. Build metadata is not part of {@link ParsedVersion}, so it never
 * affects the order. Returns -1, 0 or 1.
 */
export function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return comparePrereleases(left.prerelease, right.prerelease);
}

/** True when a version string is at least {@link MINIMUM_PASEO_VERSION}. */
export function meetsMinimumPaseoVersion(version: string): boolean {
  const parsed = parseVersion(version);
  const minimum = parseVersion(MINIMUM_PASEO_VERSION);
  if (parsed === null || minimum === null) return false;
  return compareVersions(parsed, minimum) >= 0;
}

/* -------------------------------------------------------------------- checks */

/** macOS and Linux only. Native Windows stops the run here, before any write. */
export function checkOperatingSystem(platform: NodeJS.Platform): PreflightFinding {
  if (SUPPORTED_PLATFORMS.includes(platform)) {
    return ok("operating-system", `The operating system (\`${platform}\`) is supported.`);
  }
  return fail("operating-system", "E_UNSUPPORTED_OS", `This machine reports \`${platform}\`.`);
}

/** The Node floor. An unreadable version is treated as too old, never as fine. */
export function checkNodeVersion(version: string): PreflightFinding {
  const parsed = parseVersion(version);
  if (parsed === null) {
    return fail("node-version", "E_NODE_TOO_OLD", `The running version (\`${version}\`) could not be read.`);
  }
  if (parsed.major < MINIMUM_NODE_MAJOR) {
    return fail("node-version", "E_NODE_TOO_OLD", `This process is Node ${version}.`);
  }
  return ok("node-version", `Node ${version} meets the minimum (Node ${String(MINIMUM_NODE_MAJOR)}).`);
}

/** Which check a CLI failure belongs to: the CLI itself, or the daemon behind it. */
const DAEMON_FAILURE_CHECKS: Readonly<Record<PaseoFailureReason, PreflightCheckId>> = {
  "cli-missing": "paseo-cli",
  "spawn-failed": "paseo-cli",
  timeout: "paseo-daemon",
  "exit-code": "paseo-daemon",
  "invalid-json": "paseo-daemon",
  "unexpected-shape": "paseo-daemon",
};

/**
 * Ask the daemon who it is. Success proves three things at once: the CLI is
 * installed, the daemon is up, and Paseo's home is known.
 *
 * The adapter has already classified the failure, so the mapping here is a
 * lookup rather than a second round of guessing at stderr.
 */
export async function checkDaemon(
  adapter: PaseoAdapter,
): Promise<{ finding: PreflightFinding; status: DaemonStatus | null }> {
  try {
    const status = await adapter.daemonStatus();
    return {
      finding: ok("paseo-daemon", `The Paseo daemon answered (daemon ${status.daemonVersion}).`),
      status,
    };
  } catch (error) {
    if (isPaseoCliError(error)) {
      return {
        finding: fail(DAEMON_FAILURE_CHECKS[error.reason], error.code, error.message),
        status: null,
      };
    }
    // Nothing else should reach here; report it as "the daemon did not answer"
    // rather than inventing a code for an unknown failure.
    const detail = error instanceof Error ? error.message : String(error);
    return { finding: fail("paseo-daemon", "E_DAEMON_UNREACHABLE", detail), status: null };
  }
}

/**
 * The CLI and the daemon must report the same version, and it must be at least
 * {@link MINIMUM_PASEO_VERSION}. Two halves of one supportability question, so
 * they share one code.
 */
export function checkPaseoVersion(status: Pick<DaemonStatus, "cliVersion" | "daemonVersion">): PreflightFinding {
  const { cliVersion, daemonVersion } = status;

  if (cliVersion !== daemonVersion) {
    return fail(
      "paseo-version",
      "E_VERSION_MISMATCH",
      `The CLI reports ${cliVersion} and the daemon reports ${daemonVersion}.`,
    );
  }
  if (parseVersion(cliVersion) === null) {
    return fail("paseo-version", "E_VERSION_MISMATCH", `The reported version \`${cliVersion}\` could not be read.`);
  }
  if (!meetsMinimumPaseoVersion(cliVersion)) {
    return fail(
      "paseo-version",
      "E_VERSION_MISMATCH",
      `This Paseo is ${cliVersion}; paseo-bm needs ${MINIMUM_PASEO_VERSION} or newer.`,
    );
  }
  return ok("paseo-version", `Paseo ${cliVersion} is supported, and the CLI and daemon agree.`);
}

/** A real, read-only probe: three questions, no way to change anything. */
export const realFsProbe: FsProbe = {
  exists(path: string): boolean {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  isWritableDirectory(path: string): boolean {
    try {
      // Creating an entry needs both: write on the directory, and search on it.
      accessSync(path, constants.W_OK | constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  isExecutableFile(path: string): boolean {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * The deepest part of `target` that exists. The install home usually does not
 * exist yet on a first run, so the question is not "can I write into it" but
 * "can I create it", which is a question about its nearest existing ancestor.
 */
export function nearestExistingAncestor(target: string, probe: FsProbe = realFsProbe): string | null {
  let current = resolve(target);
  for (;;) {
    if (probe.exists(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Can the install home be written? Answered without writing: find the nearest
 * existing ancestor and ask the OS about its permissions.
 *
 * A permission problem is `E_TARGET_NOT_WRITABLE` (Design §4.4 errata
 * 2026-09-15); something that is in the way — no usable ancestor, or a file
 * where a directory should be — is `E_CONFLICT`. Either way the exit code is
 * 3: nothing was written.
 */
export function checkInstallHomeWritable(target: string, probe: FsProbe = realFsProbe): PreflightFinding {
  const absolute = resolve(target);
  const ancestor = nearestExistingAncestor(absolute, probe);

  if (ancestor === null) {
    return fail("install-home", "E_CONFLICT", `No existing directory was found above \`${absolute}\`.`);
  }
  if (!probe.isDirectory(ancestor)) {
    return fail("install-home", "E_CONFLICT", `\`${ancestor}\` is in the way and is not a directory.`);
  }
  if (!probe.isWritableDirectory(ancestor)) {
    return ancestor === absolute
      ? fail("install-home", "E_TARGET_NOT_WRITABLE", `The install home \`${absolute}\` is not writable.`)
      : fail(
          "install-home",
          "E_TARGET_NOT_WRITABLE",
          `The install home \`${absolute}\` cannot be created because \`${ancestor}\` is not writable.`,
        );
  }
  return ok(
    "install-home",
    ancestor === absolute
      ? `The install home \`${absolute}\` is writable.`
      : `The install home \`${absolute}\` can be created under \`${ancestor}\`.`,
  );
}

/**
 * Find an executable on PATH by looking, not by running it: paseo-bm has no
 * business executing a stranger's `br` just to learn that it exists.
 */
export function findExecutableOnPath(
  name: string,
  options: { env?: Readonly<Record<string, string | undefined>>; fs?: FsProbe } = {},
): string | null {
  const env = options.env ?? process.env;
  const probe = options.fs ?? realFsProbe;
  const rawPath = env["PATH"] ?? "";
  for (const entry of rawPath.split(delimiter)) {
    const dir = entry.trim();
    if (dir.length === 0) continue;
    const candidate = isAbsolute(dir) ? join(dir, name) : join(resolve(dir), name);
    if (probe.isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The beads CLI. **A warning, never a block** (REQ-002): the install works
 * fine without it; only Worker's beads work is unavailable until it is there.
 */
export function checkBeadsCli(
  options: { env?: Readonly<Record<string, string | undefined>>; fs?: FsProbe } = {},
): { finding: PreflightFinding; path: string | null } {
  for (const name of BEADS_CLI_NAMES) {
    const found = findExecutableOnPath(name, options);
    if (found !== null) {
      return { finding: ok("beads-cli", `The beads CLI is available (\`${found}\`).`), path: found };
    }
  }
  return { finding: flag("beads-cli", "W_BEADS_CLI_MISSING", "warn"), path: null };
}

/* ----------------------------------------------------------------- the gate */

/**
 * Run every check in order and stop at the first blocking one.
 *
 * Stopping early is deliberate: a version cannot be compared when the daemon
 * never answered, and reporting an invented second failure on top of the real
 * one only makes the remediation harder to find. `doctor` (WP-111) is the
 * command that wants every check regardless; it composes the same functions.
 *
 * This function performs no writes. Its whole filesystem footprint is
 * `stat`/`access`, plus whatever the `paseo` CLI does in its own process.
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  const platform = options.platform ?? process.platform;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const installHome = resolve(options.installHome);
  const env = options.env ?? process.env;
  const probe = options.fs ?? realFsProbe;

  const findings: PreflightFinding[] = [];
  const warnings: ReportWarning[] = [];
  let daemonStatus: DaemonStatus | null = null;
  let beadsCli: string | null = null;

  const settle = (failure: PreflightFailure | null): PreflightResult => ({
    ok: failure === null,
    failure,
    findings,
    checks: findings.map(toCheck),
    warnings,
    facts: {
      platform,
      nodeVersion,
      installHome,
      paseoHome: daemonStatus?.home ?? null,
      cliVersion: daemonStatus?.cliVersion ?? null,
      daemonVersion: daemonStatus?.daemonVersion ?? null,
      beadsCli,
      daemonStatus,
    },
  });

  /** Record a finding; return the failure when it blocks. */
  const record = (finding: PreflightFinding): PreflightFailure | null => {
    findings.push(finding);
    if (finding.severity === "error") return toFailure(finding);
    if (finding.severity === "warn" && finding.code !== null) {
      warnings.push({ code: finding.code as ReportWarning["code"] });
    }
    return null;
  };

  const osFailure = record(checkOperatingSystem(platform));
  if (osFailure !== null) return settle(osFailure);

  const nodeFailure = record(checkNodeVersion(nodeVersion));
  if (nodeFailure !== null) return settle(nodeFailure);

  const daemon = await checkDaemon(options.adapter);
  daemonStatus = daemon.status;
  const daemonFailure = record(daemon.finding);
  if (daemonFailure !== null || daemon.status === null) {
    return settle(daemonFailure ?? toFailure(fail("paseo-daemon", "E_DAEMON_UNREACHABLE")));
  }

  const versionFailure = record(checkPaseoVersion(daemon.status));
  if (versionFailure !== null) return settle(versionFailure);

  const homeFailure = record(checkInstallHomeWritable(installHome, probe));
  if (homeFailure !== null) return settle(homeFailure);

  if (options.skipBeadsCheck !== true) {
    const beads = checkBeadsCli({ env, fs: probe });
    beadsCli = beads.path;
    record(beads.finding);
  }

  return settle(null);
}
