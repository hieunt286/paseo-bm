/**
 * The single adapter over the `paseo` CLI (ADR-004, Technical Design §4.7).
 *
 * Everything paseo-bm's installer needs from Paseo goes through this module:
 * `daemon status`, `daemon reload`, `plugin install`, `plugin ls`,
 * `plugin logs` and `plugin remove`, always with `--json`. ADR-004 chose the
 * CLI over the SDK so paseo-bm never has to track an SDK version, and the price
 * of that choice is paid here: the JSON shapes are treated as untrusted input,
 * only the fields actually needed are read, and anything else is reported as
 * `E_PASEO_OUTPUT_UNEXPECTED` instead of being believed.
 *
 * Three rules this file exists to enforce:
 *
 * 1. Child processes are started with an argv array and never through a command
 *    interpreter, so a plugin directory containing spaces, quotes or `;` is one
 *    argument and can never become a second command.
 * 2. Every call is bounded by {@link PASEO_CALL_TIMEOUT_MS} (15 seconds,
 *    Technical Design §4.7). When the deadline passes the child is terminated,
 *    escalated to SIGKILL, and the call fails with a diagnostic code.
 * 3. `enabled` is NOT `status`. `enabled` is the plugin's own switch and is
 *    always true after a successful install; only `status` says whether the
 *    plugin is actually `running` or `disabled` (verified on a live daemon,
 *    Paseo 0.8.0, 2026-09-14). Ask {@link isPluginRunning}, never `enabled`.
 *
 * Deliberately absent: `daemon restart` and `daemon stop`. Both can kill the
 * user's running agents, so this adapter offers no way to reach them.
 */
import { spawn } from "node:child_process";
import type { ErrorCode } from "../errors.js";

/** Per-call deadline for every `paseo` invocation, Technical Design §4.7. */
export const PASEO_CALL_TIMEOUT_MS = 15_000;

/**
 * Grace period between asking a timed-out child to stop and killing it
 * outright. Short on purpose: the deadline has already passed.
 */
export const PASEO_KILL_GRACE_MS = 2_000;

/** Most stdout/stderr kept per call; beyond this the stream is truncated. */
const MAX_CAPTURED_BYTES = 1_048_576;

/** The plugin status that means "loaded and running", per ADR-004. */
export const PLUGIN_STATUS_RUNNING = "running";

/** The plugin status a plugin has while the global plugin switch is off. */
export const PLUGIN_STATUS_DISABLED = "disabled";

/**
 * Why a call failed, at a finer grain than the diagnostic code. Callers that
 * need to tell "the CLI reported a failure" apart from "the daemon never
 * answered" — WP-105 mapping a plugin-load failure, for example — match on this
 * rather than re-deriving it from the message.
 */
export type PaseoFailureReason =
  | "cli-missing"
  | "spawn-failed"
  | "timeout"
  | "exit-code"
  | "invalid-json"
  | "unexpected-shape";

/** Diagnostic code carried for each failure reason. Codes come from the registry only. */
const FAILURE_CODES: Readonly<Record<PaseoFailureReason, ErrorCode>> = {
  "cli-missing": "E_PASEO_CLI_MISSING",
  "spawn-failed": "E_PASEO_CLI_MISSING",
  timeout: "E_DAEMON_UNREACHABLE",
  "exit-code": "E_DAEMON_UNREACHABLE",
  "invalid-json": "E_PASEO_OUTPUT_UNEXPECTED",
  "unexpected-shape": "E_PASEO_OUTPUT_UNEXPECTED",
};

/** Everything known about a failed `paseo` call. */
export class PaseoCliError extends Error {
  /** Registry code, for the reporter and for `--json` consumers. */
  readonly code: ErrorCode;
  readonly reason: PaseoFailureReason;
  /** Arguments as passed, without the executable. Never re-quoted. */
  readonly argv: readonly string[];
  readonly exitCode: number | undefined;
  readonly signal: NodeJS.Signals | undefined;
  /** Captured output, kept for `--verbose`; may be truncated. */
  readonly stdout: string;
  readonly stderr: string;
  readonly timeoutMs: number | undefined;

  constructor(details: {
    reason: PaseoFailureReason;
    message: string;
    argv: readonly string[];
    exitCode?: number | undefined;
    signal?: NodeJS.Signals | undefined;
    stdout?: string;
    stderr?: string;
    timeoutMs?: number | undefined;
    cause?: unknown;
  }) {
    super(details.message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "PaseoCliError";
    this.reason = details.reason;
    this.code = FAILURE_CODES[details.reason];
    this.argv = details.argv;
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
    this.timeoutMs = details.timeoutMs;
  }
}

/** True when `value` is a `PaseoCliError`; narrower than `instanceof Error`. */
export function isPaseoCliError(value: unknown): value is PaseoCliError {
  return value instanceof PaseoCliError;
}

/** Raw result of one completed invocation, before any JSON is read. */
export interface PaseoInvocation {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface PaseoAdapterOptions {
  /** Executable to run. Default `paseo`, resolved through PATH by the OS. */
  readonly executable?: string;
  /** Per-call deadline in milliseconds. Default {@link PASEO_CALL_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Delay before a timed-out child is killed outright. Default {@link PASEO_KILL_GRACE_MS}. */
  readonly killGraceMs?: number;
  /**
   * Environment for the child. Default `process.env`. This is how a caller
   * points the CLI at a different Paseo home: set `PASEO_HOME` here.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Working directory for the child. Default: inherited. */
  readonly cwd?: string;
}

/**
 * `paseo daemon status --json`. Only the three fields preflight needs are
 * trusted; `raw` keeps the rest for `--verbose` without giving it a shape.
 */
export interface DaemonStatus {
  /** Paseo home reported by the daemon — the source of truth for paths. */
  readonly home: string;
  readonly cliVersion: string;
  readonly daemonVersion: string;
  /** Listen address when the CLI reports one as a string. */
  readonly listen: string | undefined;
  readonly raw: unknown;
}

/** `paseo daemon reload --json`. */
export interface DaemonReload {
  /** Config paths the daemon says it applied. Empty is possible; ADR-004 §4.3. */
  readonly appliedPaths: readonly string[];
  readonly raw: unknown;
}

/** One plugin as Paseo reports it. */
export interface PluginSummary {
  readonly id: string;
  /** Source directory, when the CLI reports one. */
  readonly path: string | undefined;
  /**
   * The plugin's own switch. Always true after install — it does NOT mean the
   * plugin is running. Present only for completeness; decisions read `status`.
   */
  readonly enabled: boolean | undefined;
  /** The real state: `running`, `disabled`, or whatever a future Paseo adds. */
  readonly status: string;
  readonly raw: unknown;
}

/** One line of `paseo plugin logs --json`, normalised to what is usable. */
export interface PluginLogEntry {
  readonly message: string;
  readonly level: string | undefined;
  readonly timestamp: string | undefined;
  readonly raw: unknown;
}

/** `paseo plugin remove --json`; the CLI's output shape here is not depended on. */
export interface PluginRemoval {
  readonly id: string | undefined;
  readonly raw: unknown;
}

/**
 * The only supported way to talk to the `paseo` CLI. There is intentionally no
 * member for `daemon restart` or `daemon stop`.
 */
export interface PaseoAdapter {
  /** Resolved executable, after defaults. */
  readonly executable: string;
  /** Resolved per-call deadline, after defaults. 15000 unless overridden. */
  readonly timeoutMs: number;
  /** Run an arbitrary argv and return the raw result; non-zero exit throws. */
  run(args: readonly string[]): Promise<PaseoInvocation>;
  daemonStatus(): Promise<DaemonStatus>;
  daemonReload(): Promise<DaemonReload>;
  pluginInstall(directory: string): Promise<PluginSummary>;
  pluginList(): Promise<readonly PluginSummary[]>;
  pluginLogs(pluginId?: string): Promise<readonly PluginLogEntry[]>;
  pluginRemove(pluginId: string): Promise<PluginRemoval>;
}

/**
 * True only when Paseo reports the plugin as actually running.
 *
 * The one correct way to answer "is the plugin live?". Reading `enabled`
 * instead is the trap recorded in ADR-004: it is true even while the global
 * plugin switch is off and the plugin is doing nothing.
 */
export function isPluginRunning(plugin: Pick<PluginSummary, "status">): boolean {
  return plugin.status === PLUGIN_STATUS_RUNNING;
}

/** Build an adapter. Options exist so tests can point at a fake CLI and a short deadline. */
export function createPaseoAdapter(options: PaseoAdapterOptions = {}): PaseoAdapter {
  const executable = options.executable ?? "paseo";
  const timeoutMs = options.timeoutMs ?? PASEO_CALL_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? PASEO_KILL_GRACE_MS;

  async function run(args: readonly string[]): Promise<PaseoInvocation> {
    return await runPaseo(executable, args, {
      timeoutMs,
      killGraceMs,
      env: options.env,
      cwd: options.cwd,
    });
  }

  async function runJson(args: readonly string[]): Promise<{ value: unknown; argv: readonly string[] }> {
    const invocation = await run(args);
    return { value: parseJsonOutput(invocation), argv: invocation.argv };
  }

  return {
    executable,
    timeoutMs,
    run,

    async daemonStatus(): Promise<DaemonStatus> {
      const { value, argv } = await runJson(["daemon", "status", "--json"]);
      // Paseo 0.9 dropped `cliVersion` from `daemon status`; the CLI still
      // prints its own version, so ADR-004's CLI-vs-daemon check keeps its input.
      if (asNonEmptyString(asRecord(value)?.["cliVersion"]) !== undefined) return parseDaemonStatus(value, argv);
      const version = await run(["--version"]);
      return parseDaemonStatus(value, argv, version.stdout.trim().split("\n")[0]?.trim());
    },

    async daemonReload(): Promise<DaemonReload> {
      const { value, argv } = await runJson(["daemon", "reload", "--json"]);
      return parseDaemonReload(value, argv);
    },

    async pluginInstall(directory: string): Promise<PluginSummary> {
      const { value, argv } = await runJson(["plugin", "install", directory, "--json"]);
      return parsePluginSummary(value, argv);
    },

    async pluginList(): Promise<readonly PluginSummary[]> {
      const { value, argv } = await runJson(["plugin", "ls", "--json"]);
      return parsePluginList(value, argv);
    },

    async pluginLogs(pluginId?: string): Promise<readonly PluginLogEntry[]> {
      const args = pluginId === undefined ? ["plugin", "logs", "--json"] : ["plugin", "logs", pluginId, "--json"];
      const { value, argv } = await runJson(args);
      return parsePluginLogs(value, argv);
    },

    async pluginRemove(pluginId: string): Promise<PluginRemoval> {
      const invocation = await run(["plugin", "remove", pluginId, "--json"]);
      // `remove` is the one command whose JSON payload nothing depends on, so
      // silence is accepted as success rather than invented into a shape.
      if (invocation.stdout.trim().length === 0) {
        return { id: undefined, raw: null };
      }
      return parsePluginRemoval(parseJsonOutput(invocation), invocation.argv);
    },
  };
}

interface RunOptions {
  readonly timeoutMs: number;
  readonly killGraceMs: number;
  readonly env: NodeJS.ProcessEnv | undefined;
  readonly cwd: string | undefined;
}

/**
 * Run the CLI once and capture its output.
 *
 * `spawn` with an argv array: no command interpreter is involved, so no
 * argument is ever word-split, globbed or re-parsed. stdin is /dev/null so a
 * CLI that decides to prompt gets EOF instead of hanging until the deadline.
 * The child gets its own process group, which lets a timeout take down any
 * grandchildren with it instead of leaving them behind.
 */
async function runPaseo(
  executable: string,
  args: readonly string[],
  options: RunOptions,
): Promise<PaseoInvocation> {
  const argv = [...args];
  const startedAt = Date.now();

  return await new Promise<PaseoInvocation>((resolve, reject) => {
    const child = spawn(executable, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    let graceTimer: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      terminate(child, "SIGTERM");
      graceTimer = setTimeout(() => terminate(child, "SIGKILL"), options.killGraceMs);
      graceTimer.unref();
    }, options.timeoutMs);
    deadline.unref();

    const cleanup = (): void => {
      clearTimeout(deadline);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_CAPTURED_BYTES) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_CAPTURED_BYTES) stderr += chunk;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      const missing = error.code === "ENOENT" || error.code === "EACCES";
      reject(
        new PaseoCliError({
          reason: missing ? "cli-missing" : "spawn-failed",
          message: missing
            ? `The \`${executable}\` command could not be run (${error.code ?? "unknown error"}).`
            : `Could not start \`${executable} ${argv.join(" ")}\`: ${error.message}`,
          argv,
          stdout,
          stderr,
          cause: error,
        }),
      );
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (timedOut) {
        reject(
          new PaseoCliError({
            reason: "timeout",
            message: `\`${executable} ${argv.join(" ")}\` did not finish within ${options.timeoutMs} ms and was stopped.`,
            argv,
            exitCode: code ?? undefined,
            signal: signal ?? undefined,
            stdout,
            stderr,
            timeoutMs: options.timeoutMs,
          }),
        );
        return;
      }

      if (code !== 0 || signal !== null) {
        reject(
          new PaseoCliError({
            reason: "exit-code",
            message:
              signal !== null
                ? `\`${executable} ${argv.join(" ")}\` was terminated by ${signal}.`
                : `\`${executable} ${argv.join(" ")}\` failed with exit code ${String(code)}.`,
            argv,
            exitCode: code ?? undefined,
            signal: signal ?? undefined,
            stdout,
            stderr,
          }),
        );
        return;
      }

      resolve({ argv, exitCode: 0, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

/** Signal the child's whole process group, falling back to the child alone. */
function terminate(child: { pid?: number | undefined; kill: (signal: NodeJS.Signals) => boolean }, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // The group is already gone, or this platform refused: fall through.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited; nothing to do.
  }
}

function unexpected(argv: readonly string[], detail: string, invocation?: PaseoInvocation): PaseoCliError {
  return new PaseoCliError({
    reason: "unexpected-shape",
    message: `\`paseo ${argv.join(" ")}\` returned JSON that does not match what paseo-bm expects: ${detail}.`,
    argv,
    stdout: invocation?.stdout,
    stderr: invocation?.stderr,
  });
}

/**
 * Turn captured stdout into JSON, tolerating log lines printed before the
 * payload but never guessing at anything else.
 */
export function parseJsonOutput(invocation: PaseoInvocation): unknown {
  const text = invocation.stdout.trim();
  if (text.length === 0) {
    throw new PaseoCliError({
      reason: "invalid-json",
      message: `\`paseo ${invocation.argv.join(" ")}\` printed no JSON output.`,
      argv: invocation.argv,
      stdout: invocation.stdout,
      stderr: invocation.stderr,
    });
  }

  const direct = tryParse(text);
  if (direct.ok) return direct.value;

  const lines = text.split("\n");
  for (let index = 1; index < lines.length; index += 1) {
    const candidate = lines.slice(index).join("\n").trim();
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    const parsed = tryParse(candidate);
    if (parsed.ok) return parsed.value;
  }

  throw new PaseoCliError({
    reason: "invalid-json",
    message: `\`paseo ${invocation.argv.join(" ")}\` printed output that is not JSON.`,
    argv: invocation.argv,
    stdout: invocation.stdout,
    stderr: invocation.stderr,
  });
}

/** Most characters of Paseo's own failure text carried into a paseo-bm message. */
const MAX_REASON_CHARS = 2_000;

/**
 * Paseo's own words for a failed call, verbatim, or `undefined` when it gave
 * none. A failing `paseo … --json` prints `{"error": {"message": "…"}}`
 * (seen on Paseo 0.8.0: `{"error": {"name": "DaemonRpcError", "code":
 * "handler_error", "message": "Request failed: …"}}`), so stdout and then
 * stderr are searched for that document; otherwise stderr's text is used.
 * Only `message` is taken from the JSON — nothing else Paseo printed is copied.
 * The text still passes through the report's redactor on the way out.
 */
export function paseoFailureDetail(error: PaseoCliError): string | undefined {
  for (const stream of [error.stdout, error.stderr]) {
    const message = errorMessageIn(stream);
    if (message !== undefined) return clip(message);
  }
  const stderr = error.stderr.trim();
  return stderr.length > 0 ? clip(stderr) : undefined;
}

function errorMessageIn(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const lines = trimmed.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = lines.slice(index).join("\n").trim();
    if (!candidate.startsWith("{")) continue;
    const parsed = tryParse(candidate);
    if (!parsed.ok) continue;
    const record = asRecord(parsed.value);
    const inner = record?.["error"];
    if (typeof inner === "string" && inner.trim().length > 0) return inner.trim();
    const innerMessage = asNonEmptyString(asRecord(inner)?.["message"]);
    if (innerMessage !== undefined) return innerMessage.trim();
    const message = asNonEmptyString(record?.["message"]);
    if (message !== undefined) return message.trim();
  }
  return undefined;
}

function clip(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}…` : text;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * `daemon status`: home, cliVersion and daemonVersion are required; the rest is not read.
 * `cliVersion` falls back to what `paseo --version` printed, for a Paseo whose
 * status no longer reports it.
 */
export function parseDaemonStatus(value: unknown, argv: readonly string[], printedCliVersion?: string): DaemonStatus {
  const record = asRecord(value);
  if (record === undefined) throw unexpected(argv, "the payload is not a JSON object");

  const home = asNonEmptyString(record["home"]);
  const cliVersion = asNonEmptyString(record["cliVersion"]) ?? asNonEmptyString(printedCliVersion);
  const daemonVersion = asNonEmptyString(record["daemonVersion"]);
  const missing = [
    home === undefined ? "home" : undefined,
    cliVersion === undefined ? "cliVersion" : undefined,
    daemonVersion === undefined ? "daemonVersion" : undefined,
  ].filter((field): field is string => field !== undefined);
  if (home === undefined || cliVersion === undefined || daemonVersion === undefined) {
    throw unexpected(argv, `missing or non-string field(s) ${missing.join(", ")}`);
  }

  return { home, cliVersion, daemonVersion, listen: asNonEmptyString(record["listen"]), raw: value };
}

/** `daemon reload`: only `appliedPaths` is read, and an absent list means "none reported". */
export function parseDaemonReload(value: unknown, argv: readonly string[]): DaemonReload {
  const record = asRecord(value);
  if (record === undefined) throw unexpected(argv, "the payload is not a JSON object");

  const applied = record["appliedPaths"];
  if (applied === undefined || applied === null) {
    return { appliedPaths: [], raw: value };
  }
  if (!Array.isArray(applied)) {
    throw unexpected(argv, "appliedPaths is present but is not an array");
  }
  const paths = applied.filter((entry): entry is string => typeof entry === "string");
  if (paths.length !== applied.length) {
    throw unexpected(argv, "appliedPaths contains a non-string entry");
  }
  return { appliedPaths: paths, raw: value };
}

/**
 * One plugin. `id` and `status` are required; `enabled` is recorded but is
 * never the answer to "is it running" — see {@link isPluginRunning}.
 */
export function parsePluginSummary(value: unknown, argv: readonly string[]): PluginSummary {
  const record = asRecord(value);
  if (record === undefined) throw unexpected(argv, "the plugin entry is not a JSON object");

  const id = asNonEmptyString(record["id"]);
  if (id === undefined) throw unexpected(argv, "the plugin entry has no string `id`");
  const status = asNonEmptyString(record["status"]);
  if (status === undefined) {
    throw unexpected(argv, `the plugin entry for \`${id}\` has no string \`status\``);
  }

  return {
    id,
    path: asNonEmptyString(record["path"]),
    enabled: typeof record["enabled"] === "boolean" ? record["enabled"] : undefined,
    status,
    raw: value,
  };
}

/** `plugin ls`: a bare array, or an object wrapping one under `plugins`. */
export function parsePluginList(value: unknown, argv: readonly string[]): readonly PluginSummary[] {
  const entries = Array.isArray(value) ? value : asRecord(value)?.["plugins"];
  if (!Array.isArray(entries)) {
    throw unexpected(argv, "the payload is neither an array of plugins nor an object with a `plugins` array");
  }
  return entries.map((entry) => parsePluginSummary(entry, argv));
}

/** `plugin logs`: an array, or an object wrapping one under `entries` / `logs`. */
export function parsePluginLogs(value: unknown, argv: readonly string[]): readonly PluginLogEntry[] {
  const record = asRecord(value);
  const entries = Array.isArray(value) ? value : (record?.["entries"] ?? record?.["logs"]);
  if (!Array.isArray(entries)) {
    throw unexpected(argv, "the payload is neither an array of log entries nor an object with an `entries` array");
  }

  return entries.map((entry) => {
    if (typeof entry === "string") {
      return { message: entry, level: undefined, timestamp: undefined, raw: entry };
    }
    const entryRecord = asRecord(entry);
    if (entryRecord === undefined) throw unexpected(argv, "a log entry is neither a string nor an object");
    const message = typeof entryRecord["message"] === "string" ? entryRecord["message"] : undefined;
    if (message === undefined) throw unexpected(argv, "a log entry has no string `message`");
    return {
      message,
      level: asNonEmptyString(entryRecord["level"]),
      timestamp: asNonEmptyString(entryRecord["timestamp"]),
      raw: entry,
    };
  });
}

/** `plugin remove`: nothing depends on the payload, so only an object is required. */
export function parsePluginRemoval(value: unknown, argv: readonly string[]): PluginRemoval {
  const record = asRecord(value);
  if (record === undefined) throw unexpected(argv, "the payload is not a JSON object");
  return { id: asNonEmptyString(record["id"]), raw: value };
}
