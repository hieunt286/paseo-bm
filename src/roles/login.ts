/**
 * Provider login check and login delegation (REQ-027(b)(c), Design §4.7 · §9,
 * ADR-006 decision 2).
 *
 * The promise this file keeps: **paseo-bm never reads, types in, or stores a
 * credential.** Authentication belongs to the provider's own tool. So this
 * module does exactly three things and nothing more:
 *
 * 1. Ask *Paseo* whether a provider is logged in (`paseo provider diagnostic
 *    <id> --json`) and keep one boolean out of the answer — never the text.
 * 2. When it is not, print the provider tool's own login command verbatim and
 *    ask. On consent, start that command as a child process with an argv array
 *    (no command interpreter) and `stdio: "inherit"`, so the tool talks to the
 *    user's terminal directly and none of its output passes through paseo-bm.
 * 3. When the user declines, the session cannot ask, the command fails, or no
 *    login command is known: print manual instructions and attach
 *    `W_PROVIDER_NOT_LOGGED_IN`. That never blocks the install.
 *
 * Pi is the one exception to all three (REQ-063 (f), Design delta 20260921
 * §4.2.5): paseo-bm knows no login command for it, so the installer prints
 * {@link PI_SIGN_IN_GUIDANCE}, records the state as `unknown`, and starts no
 * process at all — neither `paseo` nor a login tool.
 *
 * This file performs no filesystem access at all; `test/provider-login.test.ts`
 * wraps `node:fs` to prove it.
 *
 * ## Why the diagnostic text is thrown away
 *
 * Paseo 0.8.0's diagnostic is free text, and what it contains varies by
 * provider (checked on a live daemon, 2026-09-15): Claude's includes an `Auth:`
 * JSON block with `loggedIn`, the account e-mail and organisation id; Codex's
 * has no auth line at all; OpenCode's lists its stored credential entries. Only
 * the `loggedIn` boolean and the `Status:` word are extracted. The rest is
 * never stored, returned, or printed. A provider whose diagnostic carries no
 * `loggedIn` is reported as `unknown` — never guessed to be logged out.
 */

import { spawn } from "node:child_process";
import type { Check } from "../action.js";
import { diagnostic } from "../errors.js";
import { PaseoCliError, parseJsonOutput } from "../paseo/adapter.js";
import type { Prompter } from "../prompter.js";
import type { RoleName } from "../record.js";
import type { PaseoRunner, RoleSelection } from "./config.js";

/* ------------------------------------------------------------------ *
 * Reading the login state from Paseo.
 * ------------------------------------------------------------------ */

/** `paseo provider diagnostic <provider> --json`. Read-only. */
export function providerDiagnosticArgv(providerId: string): readonly string[] {
  return ["provider", "diagnostic", providerId, "--json"];
}

export type ProviderLoginState = "logged-in" | "logged-out" | "unknown";

/** What paseo-bm keeps from a diagnostic. Deliberately nothing else. */
export interface ProviderLoginStatus {
  readonly provider: string;
  readonly state: ProviderLoginState;
  /** Paseo's `Status:` word (e.g. `Ready`), when it is a single plain word. */
  readonly paseoStatus: string | null;
}

const LOGGED_IN_PATTERN = /"loggedIn"\s*:\s*(true|false)/;
const STATUS_PATTERN = /^\s*Status:\s*([A-Za-z][A-Za-z -]{0,31})\s*$/m;

/**
 * Keep the login boolean and the status word out of a diagnostic payload.
 * Anything unexpected yields `unknown`: a login check must never fail an
 * install, and must never invent a "not logged in".
 */
export function parseProviderDiagnostic(providerId: string, value: unknown): ProviderLoginStatus {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const text = record?.["diagnostic"];
  if (typeof text !== "string") {
    return { provider: providerId, state: "unknown", paseoStatus: null };
  }
  const loggedIn = LOGGED_IN_PATTERN.exec(text)?.[1];
  const status = STATUS_PATTERN.exec(text)?.[1]?.trim() ?? null;
  return {
    provider: providerId,
    state: loggedIn === "true" ? "logged-in" : loggedIn === "false" ? "logged-out" : "unknown",
    paseoStatus: status,
  };
}

/** Ask Paseo about one provider. A failed call is `unknown`, never an error. */
export async function checkProviderLogin(runner: PaseoRunner, providerId: string): Promise<ProviderLoginStatus> {
  try {
    const invocation = await runner.run(providerDiagnosticArgv(providerId));
    return parseProviderDiagnostic(providerId, parseJsonOutput(invocation));
  } catch (error) {
    if (error instanceof PaseoCliError) {
      return { provider: providerId, state: "unknown", paseoStatus: null };
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * The provider tools' own login commands.
 * ------------------------------------------------------------------ */

/** A login command as an argv vector. Never a command string. */
export interface LoginCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

/**
 * Login commands of the provider tools, keyed by the exact Paseo provider id.
 *
 * The Technical Design does not list these. Each was read from the tool's own
 * `--help` on 2026-09-15: Claude Code 2.1.271 (`claude auth login`), Codex CLI
 * (`codex login`), OpenCode (`opencode providers login`; `auth` is an alias).
 * A provider not listed here — including ids such as `codex-lead` that wrap a
 * listed tool — gets manual instructions instead of a guessed command. Pi is
 * deliberately absent too: it gets {@link PI_SIGN_IN_GUIDANCE} instead.
 */
export const PROVIDER_LOGIN_COMMANDS: Readonly<Record<string, LoginCommand>> = {
  claude: { executable: "claude", args: ["auth", "login"] },
  codex: { executable: "codex", args: ["login"] },
  opencode: { executable: "opencode", args: ["providers", "login"] },
};

/** The Paseo provider id of Pi. Exact match only, like {@link PROVIDER_LOGIN_COMMANDS}. */
export const PI_PROVIDER_ID = "pi";

/** What the installer prints for Pi instead of offering a login command (Design delta 20260921 §4.2.5). */
export const PI_SIGN_IN_GUIDANCE =
  "Pi has no login command paseo-bm knows; sign in the way Pi's own documentation describes, then run doctor.";

export function loginCommandFor(providerId: string): LoginCommand | undefined {
  return Object.prototype.hasOwnProperty.call(PROVIDER_LOGIN_COMMANDS, providerId)
    ? PROVIDER_LOGIN_COMMANDS[providerId]
    : undefined;
}

/**
 * The command exactly as it will run. Arguments containing anything a reader
 * could mis-split are shown in single quotes; the argv itself is never built
 * from this string.
 */
export function formatLoginCommand(command: LoginCommand): string {
  return [command.executable, ...command.args]
    .map((part) => (/^[A-Za-z0-9._/:=@+-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`))
    .join(" ");
}

/* ------------------------------------------------------------------ *
 * Running a login command.
 * ------------------------------------------------------------------ */

/**
 * Deadline for one interactive login. The Design fixes no value for it; this
 * mirrors the 300 seconds it gives the `skills` CLI (§4.7), the other external
 * tool behind trust boundary 2. A browser sign-in needs minutes, not seconds.
 */
export const LOGIN_TIMEOUT_MS = 300_000;

/** Grace between SIGTERM and SIGKILL once the deadline has passed. */
export const LOGIN_KILL_GRACE_MS = 2_000;

export type LoginRunResult =
  | { readonly ok: true; readonly exitCode: 0 }
  | {
      readonly ok: false;
      readonly reason: "not-found" | "spawn-failed" | "exit-code" | "timeout";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    };

export interface LoginRunOptions {
  readonly timeoutMs?: number;
  readonly killGraceMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

/** The seam tests replace. {@link runLoginCommand} is the real one. */
export type LoginSpawner = (command: LoginCommand, options: LoginRunOptions) => Promise<LoginRunResult>;

/**
 * Start the tool's login command and wait for it.
 *
 * - argv array, no command interpreter: nothing in an argument is re-parsed.
 * - `stdio: "inherit"`: the tool owns the terminal; no stream is piped back,
 *   so paseo-bm never sees a code, a URL token or a key the user types.
 * - Not `detached`, unlike the Paseo adapter: a child in its own process group
 *   is a background job and gets SIGTTIN the moment it reads the terminal,
 *   which would break every interactive login. Only the child is signalled on
 *   timeout.
 */
export function runLoginCommand(command: LoginCommand, options: LoginRunOptions = {}): Promise<LoginRunResult> {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? LOGIN_KILL_GRACE_MS;

  return new Promise<LoginRunResult>((resolve) => {
    const child = spawn(command.executable, [...command.args], {
      stdio: "inherit",
      shell: false,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });

    let settled = false;
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      graceTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      graceTimer.unref();
    }, timeoutMs);
    deadline.unref();

    const finish = (result: LoginRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      resolve(result);
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      const notFound = error.code === "ENOENT" || error.code === "EACCES";
      finish({ ok: false, reason: notFound ? "not-found" : "spawn-failed", exitCode: null, signal: null });
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        finish({ ok: false, reason: "timeout", exitCode: code, signal });
      } else if (code === 0 && signal === null) {
        finish({ ok: true, exitCode: 0 });
      } else {
        finish({ ok: false, reason: "exit-code", exitCode: code, signal });
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * The install step.
 * ------------------------------------------------------------------ */

export type LoginOutcome =
  /** Paseo already reports a login session. */
  | "already-logged-in"
  /**
   * Paseo cannot tell; nothing is asked and nothing is warned. For Pi this is
   * the outcome by design, with {@link PI_SIGN_IN_GUIDANCE} printed.
   */
  | "unknown"
  /** The login command ran and Paseo now reports a session. */
  | "logged-in"
  /** The login command exited 0 but Paseo still reports no session. */
  | "still-logged-out"
  | "declined"
  | "non-interactive"
  | "no-command"
  | "failed";

export interface ProviderLoginWarning {
  readonly code: "W_PROVIDER_NOT_LOGGED_IN";
  readonly provider: string;
  readonly roles: readonly RoleName[];
  readonly message: string;
  readonly remediation: string;
}

export interface ProviderLoginResult {
  readonly provider: string;
  /** Every role that uses this provider; a provider is checked once. */
  readonly roles: readonly RoleName[];
  readonly before: ProviderLoginState;
  readonly after: ProviderLoginState;
  readonly outcome: LoginOutcome;
  /** The command as printed, or null when none is known. */
  readonly command: string | null;
  /** Whether that command was started. Only ever true after a yes. */
  readonly ran: boolean;
  readonly run: LoginRunResult | null;
  /** What was printed for the user to do by hand; empty when nothing is needed. */
  readonly manualInstructions: readonly string[];
  readonly warning: ProviderLoginWarning | null;
}

export interface ProviderLoginReport {
  readonly providers: readonly ProviderLoginResult[];
  readonly warnings: readonly ProviderLoginWarning[];
  /** Always false: a missing login never stops an install (Design §4.5, §4.7). */
  readonly blocksInstall: false;
}

export interface EnsureProviderLoginsOptions {
  readonly selections: readonly RoleSelection[];
  readonly runner: PaseoRunner;
  readonly prompter: Prompter;
  /** Where lines for the user go. Default: stdout. */
  readonly print?: (line: string) => void;
  /** Default {@link runLoginCommand}. */
  readonly spawnLogin?: LoginSpawner;
  readonly loginOptions?: LoginRunOptions;
}

const ROLE_LABELS: Readonly<Record<RoleName, string>> = {
  manager: "Manager",
  worker: "Worker",
  reviewer: "Reviewer",
};

function describeFailure(run: LoginRunResult): string {
  if (run.ok) return "";
  switch (run.reason) {
    case "not-found":
      return "the command could not be found";
    case "spawn-failed":
      return "the command could not be started";
    case "timeout":
      return "it did not finish in time and was stopped";
    case "exit-code":
      return run.signal !== null
        ? `it was terminated by ${run.signal}`
        : `it exited with code ${String(run.exitCode)}`;
  }
}

function manualSteps(providerId: string, command: string | null): string[] {
  const doctor = "Then run `paseo-bm doctor` to confirm. The role stays registered either way.";
  return command === null
    ? [
        `Log in to provider "${providerId}" with that tool's own login command; paseo-bm does not know it and never handles credentials.`,
        doctor,
      ]
    : [`Log in to provider "${providerId}" yourself by running:`, `  ${command}`, doctor];
}

/**
 * For every provider the roles use: check the login, offer the tool's own
 * login command, and turn anything short of a confirmed session into a
 * warning. Always resolves; never blocks the install.
 */
export async function ensureProviderLogins(options: EnsureProviderLoginsOptions): Promise<ProviderLoginReport> {
  const print = options.print ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const spawnLogin = options.spawnLogin ?? runLoginCommand;
  const entry = diagnostic("W_PROVIDER_NOT_LOGGED_IN");

  const rolesByProvider = new Map<string, RoleName[]>();
  for (const selection of options.selections) {
    const roles = rolesByProvider.get(selection.provider) ?? [];
    roles.push(selection.role);
    rolesByProvider.set(selection.provider, roles);
  }

  const providers: ProviderLoginResult[] = [];
  for (const [provider, roles] of rolesByProvider) {
    if (provider === PI_PROVIDER_ID) {
      // Pi: no login command to offer, and its state is `unknown` like every
      // provider but Claude. Print the guidance; start no process.
      print(PI_SIGN_IN_GUIDANCE);
      providers.push({
        provider,
        roles,
        before: "unknown",
        after: "unknown",
        command: null,
        outcome: "unknown",
        ran: false,
        run: null,
        manualInstructions: [PI_SIGN_IN_GUIDANCE],
        warning: null,
      });
      continue;
    }

    const before = (await checkProviderLogin(options.runner, provider)).state;
    const login = loginCommandFor(provider);
    const command = login === undefined ? null : formatLoginCommand(login);
    const base = { provider, roles, before, command };

    if (before !== "logged-out") {
      providers.push({
        ...base,
        after: before,
        outcome: before === "logged-in" ? "already-logged-in" : "unknown",
        ran: false,
        run: null,
        manualInstructions: [],
        warning: null,
      });
      continue;
    }

    const roleList = roles.map((role) => ROLE_LABELS[role]).join(", ");
    let outcome: LoginOutcome;
    let ran = false;
    let run: LoginRunResult | null = null;
    let after: ProviderLoginState = before;
    let why: string;

    print(`Provider "${provider}" (used by ${roleList}) is not logged in.`);

    if (login === undefined || command === null) {
      outcome = "no-command";
      why = "paseo-bm knows no login command for it";
    } else if (!options.prompter.interactive) {
      outcome = "non-interactive";
      why = "there is no terminal to run its login on";
    } else {
      // The command is printed verbatim before the question and long before it runs.
      print(`paseo-bm can run this provider's own login command for you:`);
      print(`  ${command}`);
      const yes = await options.prompter.confirm({
        message: `Run \`${command}\` now?`,
        defaultValue: false,
        details: [
          "The tool handles the sign-in itself; paseo-bm does not see, type or store any credential.",
        ],
      });
      if (!yes) {
        outcome = "declined";
        why = "the login was declined";
      } else {
        print(`Running: ${command}`);
        ran = true;
        run = await spawnLogin(login, options.loginOptions ?? {});
        if (!run.ok) {
          outcome = "failed";
          why = `\`${command}\` did not succeed: ${describeFailure(run)}`;
        } else {
          after = (await checkProviderLogin(options.runner, provider)).state;
          outcome = after === "logged-out" ? "still-logged-out" : "logged-in";
          why = "Paseo still reports no login session after the command finished";
        }
      }
    }

    if (outcome === "logged-in") {
      providers.push({ ...base, after, outcome, ran, run, manualInstructions: [], warning: null });
      continue;
    }

    const manualInstructions = manualSteps(provider, command);
    for (const line of manualInstructions) print(line);
    const warning: ProviderLoginWarning = {
      code: entry.code,
      provider,
      roles,
      message: `Provider "${provider}" (${roleList}) is not logged in: ${why}.`,
      remediation: entry.remediation,
    };
    providers.push({ ...base, after, outcome, ran, run, manualInstructions, warning });
  }

  return {
    providers,
    warnings: providers.flatMap((result) => (result.warning === null ? [] : [result.warning])),
    blocksInstall: false,
  };
}

/** `doctor` findings. Never `error`: a login is the provider's business. */
export function loginChecks(statuses: readonly ProviderLoginStatus[]): readonly Check[] {
  return statuses.map((status) => {
    const id = `provider-login-${status.provider}`;
    const command = loginCommandFor(status.provider);
    switch (status.state) {
      case "logged-in":
        return { id, severity: "ok" as const, message: `${status.provider}: logged in`, remediation: "" };
      case "unknown":
        return {
          id,
          severity: "ok" as const,
          message: `${status.provider}: Paseo does not report a login state for this provider`,
          remediation: "",
        };
      case "logged-out":
        return {
          id,
          severity: "warn" as const,
          message: `${status.provider}: not logged in (W_PROVIDER_NOT_LOGGED_IN)`,
          remediation:
            command === undefined
              ? diagnostic("W_PROVIDER_NOT_LOGGED_IN").remediation
              : `Run \`${formatLoginCommand(command)}\`. ${diagnostic("W_PROVIDER_NOT_LOGGED_IN").remediation}`,
        };
    }
  });
}
