/**
 * Running the third-party `skills` CLI on the user's behalf, after consent
 * (bead bm-wp-110-rkw.3; REQ-007(d)–(j), REQ-010(e), REQ-013(c), M-1, M-9;
 * Technical Design §4.7 · §9; ADR-003).
 *
 * The split of responsibility is ADR-003's: paseo-bm **never writes inside a
 * skills directory**. The only thing it does is start the `skills` CLI — the
 * tool that owns those directories — with an argv array, no command
 * interpreter, and a constant source, and then read the directories again.
 *
 * The step, in order:
 *
 * 1. Detect (read-only). Nothing missing → remember the snapshot, done.
 * 2. Preview (`apply: false`) → report the suggested command and stop.
 * 3. `--ask-skills-again` clears a remembered "no".
 * 4. Consent: `--install-skills`, or exactly one question on a terminal that
 *    shows the argv verbatim and the target agents. A remembered "no" means no
 *    question. Without a terminal and without the flag, nothing runs.
 * 5. Run with a 300-second deadline, a warning after 60 seconds of silence, and
 *    SIGINT forwarded to the child. Under `--json` every byte of the child goes
 *    to stderr so stdout stays one JSON document.
 * 6. Detect again, report before/after, record the outcome.
 *
 * Every failure here — CLI missing, non-zero exit, timeout, interruption, even
 * a record that cannot be written — becomes a warning or a note. Nothing in
 * this file throws into the install flow, and nothing changes its exit code.
 */

import { spawn } from "node:child_process";
import type { SkillsReport } from "../action.js";
import type { SkillsStep, SkillsStepInput, SkillsStepOutcome } from "../commands/install/index.js";
import { createFsOps } from "../fsops.js";
import type { InstallRecord, SkillsAssistOutcome, SkillsRecord, SkillsStatusRecord } from "../record.js";
import { toIsoUtc, touchRecord, writeRecord } from "../record.js";
import { createRedactor } from "../redact.js";
import type { SkillsDetection } from "./detect.js";
import { REQUIRED_SKILLS, detectSkills, hasMissingRequiredSkills, isCheckedAgent, missingSkillsDetail, toSkillsByAgent } from "./detect.js";

/* ------------------------------------------------------------ constants */

/**
 * Where the skills come from. A constant of the package: Phase 1 offers no
 * flag to change it (Q-011, ADR-003 decision 4).
 */
export const SKILLS_SOURCE = "cuongntr/agent-skills";

/** Deadline for one `skills add` run (Design §4.7). */
export const SKILLS_TIMEOUT_MS = 300_000;

/** Silence after which the user is told the CLI is still running (Design §4.7). */
export const SKILLS_SILENCE_WARNING_MS = 60_000;

/**
 * Grace between the polite signal and SIGKILL, after the deadline or an
 * interruption. Not fixed by the Design; the same value the provider login
 * runner uses (`src/roles/login.ts`).
 */
export const SKILLS_KILL_GRACE_MS = 2_000;

/** The skills confirmation. The third of the three confirmations counted by M-1. */
export const SKILLS_QUESTION = "Run the skills CLI now to install the missing agent skills?";

/* -------------------------------------------------------------- the argv */

/** A command as an argv vector. Never a command string. */
export interface SkillsCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

/**
 * `npx -y skills add cuongntr/agent-skills -g -a <agents…> -s <5 skills> -y`.
 *
 * - No `--copy`: the CLI's default symlink mode (ADR-003 decision 5, Q-015).
 * - `-a` and `-s` take several space-separated values each. That is how
 *   `skills` 1.5.26 parses them (`parseAddOptions` consumes arguments until the
 *   next one starting with `-`); a comma-joined value would be read as one
 *   agent name. The agent names were validated at parse time and can never
 *   start with `-` (Design §4.2), so none of them can end the list early or be
 *   read as a flag.
 */
/**
 * paseo-bm's agent names, as `--skills-agents` accepts them, mapped to the
 * names the `skills` CLI expects. `claude` is kept on paseo-bm's side because
 * it also names the `~/.claude` skills directory; the `skills` CLI (1.5.26)
 * only knows Claude Code as `claude-code` and rejects `claude` with "Invalid
 * agents" (owner decision 2026-09-15, Design errata). Names not listed here are
 * passed through unchanged, so `claude-code` itself is accepted too.
 */
export const SKILLS_CLI_AGENT_NAMES: Readonly<Record<string, string>> = {
  claude: "claude-code",
};

/** Translate paseo-bm agent names to `skills` CLI names, dropping duplicates in order. */
export function toSkillsCliAgents(agents: readonly string[]): string[] {
  const out: string[] = [];
  for (const agent of agents) {
    const name = Object.prototype.hasOwnProperty.call(SKILLS_CLI_AGENT_NAMES, agent)
      ? (SKILLS_CLI_AGENT_NAMES[agent] as string)
      : agent;
    if (!out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

export function skillsAddCommand(agents: readonly string[]): SkillsCommand {
  return {
    executable: "npx",
    args: ["-y", "skills", "add", SKILLS_SOURCE, "-g", "-a", ...toSkillsCliAgents(agents), "-s", ...REQUIRED_SKILLS, "-y"],
  };
}

/** The command exactly as it runs, for printing. The argv is never built from this. */
export function formatSkillsCommand(command: SkillsCommand): string {
  return [command.executable, ...command.args]
    .map((part) => (/^[A-Za-z0-9._/:=@+-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`))
    .join(" ");
}

/* ------------------------------------------------------------ the runner */

/* ------------------------------------------------------ the child's env */

/**
 * Variables npm sets for the `npx`/`npm exec` that started paseo-bm itself
 * (bug bm-zxa). Inherited by the inner `npx -y skills add …`, they describe
 * *our* invocation, not the one we start: `npm_config_package` makes the inner
 * `npx` look for a `skills` binary inside the paseo-bm package (exit 127), and
 * `npm_config_call` would replace the command outright. Every other variable,
 * including the user's own `npm_config_*` (registry, proxy, cache), is kept.
 */
export const NPM_EXEC_CONTEXT_VARS: readonly string[] = [
  "npm_config_package",
  "npm_config_call",
  "npm_command",
  "npm_lifecycle_event",
  "npm_lifecycle_script",
];

/** A copy of `env` without {@link NPM_EXEC_CONTEXT_VARS}. Never reads or prints a value. */
export function skillsChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of NPM_EXEC_CONTEXT_VARS) {
    delete out[name];
  }
  return out;
}

/** Timer seam, so tests never wait 300 real seconds. */
export interface SkillsTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: SkillsTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** The slice of `process` used to hear SIGINT. */
export interface SignalSource {
  on(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
}

export type SkillsRunResult =
  | { readonly outcome: "ok"; readonly exitCode: 0 }
  | {
      readonly outcome: "failed";
      readonly reason: "not-found" | "spawn-failed" | "exit-code" | "timeout";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly outcome: "interrupted"; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null };

export interface SkillsRunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly silenceWarningMs: number;
  readonly killGraceMs: number;
  readonly timers: SkillsTimers;
  readonly signals: SignalSource;
  readonly onStdout: (chunk: string) => void;
  readonly onStderr: (chunk: string) => void;
  /** Called once per stretch of silence that reaches `silenceWarningMs`. */
  readonly onSilence: (ms: number) => void;
}

/** The seam tests may replace. {@link runSkillsCommand} is the real one. */
export type SkillsRunner = (command: SkillsCommand, options: SkillsRunOptions) => Promise<SkillsRunResult>;

/**
 * Start the command and wait for it.
 *
 * - argv array, `shell: false`: nothing in an argument is re-parsed.
 * - stdin is closed (`-y` makes the CLI non-interactive, so a surprise prompt
 *   ends instead of hanging); stdout and stderr are piped so they can be routed
 *   (stderr only under `--json`) and so silence can be measured.
 * - Not `detached`: Ctrl+C on the terminal reaches the child anyway, and the
 *   SIGINT paseo-bm hears is forwarded to it for runs without a terminal.
 * - The env is {@link skillsChildEnv}: npm's exec context of paseo-bm's own
 *   `npx` is dropped so the inner `npx` resolves the `skills` package.
 */
export function runSkillsCommand(command: SkillsCommand, options: SkillsRunOptions): Promise<SkillsRunResult> {
  const { timers } = options;
  return new Promise<SkillsRunResult>((resolve) => {
    const child = spawn(command.executable, [...command.args], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: skillsChildEnv(options.env ?? process.env),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });

    let settled = false;
    let timedOut = false;
    let interrupted = false;
    let graceTimer: unknown;
    let silenceTimer: unknown;

    const escalate = (): void => {
      if (graceTimer !== undefined) return;
      graceTimer = timers.setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, options.killGraceMs);
    };

    const armSilence = (): void => {
      if (silenceTimer !== undefined) timers.clearTimeout(silenceTimer);
      silenceTimer = timers.setTimeout(() => {
        silenceTimer = undefined;
        if (!settled) options.onSilence(options.silenceWarningMs);
      }, options.silenceWarningMs);
    };

    const deadline = timers.setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      escalate();
    }, options.timeoutMs);
    armSilence();

    const onSigint = (): void => {
      if (settled) return;
      interrupted = true;
      child.kill("SIGINT");
      escalate();
    };
    options.signals.on("SIGINT", onSigint);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      armSilence();
      options.onStdout(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      armSilence();
      options.onStderr(chunk);
    });

    const finish = (result: SkillsRunResult): void => {
      if (settled) return;
      settled = true;
      options.signals.off("SIGINT", onSigint);
      timers.clearTimeout(deadline);
      if (silenceTimer !== undefined) timers.clearTimeout(silenceTimer);
      if (graceTimer !== undefined) timers.clearTimeout(graceTimer);
      resolve(result);
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      const notFound = error.code === "ENOENT" || error.code === "EACCES";
      finish({ outcome: "failed", reason: notFound ? "not-found" : "spawn-failed", exitCode: null, signal: null });
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (interrupted) {
        finish({ outcome: "interrupted", exitCode: code, signal });
      } else if (timedOut) {
        finish({ outcome: "failed", reason: "timeout", exitCode: code, signal });
      } else if (code === 0 && signal === null) {
        finish({ outcome: "ok", exitCode: 0 });
      } else {
        finish({ outcome: "failed", reason: "exit-code", exitCode: code, signal });
      }
    });
  });
}

/* ------------------------------------------------------------- the step */

export interface SkillsAssistDeps {
  /** Default {@link runSkillsCommand}. */
  readonly runner?: SkillsRunner;
  /** Default real timers (unref'd). */
  readonly timers?: SkillsTimers;
  /** Default `process`. */
  readonly signals?: SignalSource;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly silenceWarningMs?: number;
  readonly killGraceMs?: number;
}

function describeFailure(result: SkillsRunResult): string {
  if (result.outcome !== "failed") return "";
  switch (result.reason) {
    case "not-found":
      return "`npx` could not be found";
    case "spawn-failed":
      return "the command could not be started";
    case "timeout":
      return `it did not finish within ${String(SKILLS_TIMEOUT_MS / 1000)} seconds and was stopped`;
    case "exit-code":
      return result.signal !== null ? `it was terminated by ${result.signal}` : `it exited with code ${String(result.exitCode)}`;
  }
}

function lastStatusOf(detection: SkillsDetection): SkillsStatusRecord[] {
  return detection.agents.filter(isCheckedAgent).flatMap((entry) => [
    ...entry.present.map((skill) => ({ agent: entry.agent, skill, present: true })),
    ...entry.missing.map((skill) => ({ agent: entry.agent, skill, present: false })),
  ]);
}

function summary(detection: SkillsDetection): string {
  return missingSkillsDetail(detection) ?? "all required skills are installed for every installed agent";
}

function manualInstructions(command: string): string[] {
  return [
    "To install the missing agent skills yourself, run:",
    `  ${command}`,
    "The skills CLI is a third-party tool with its own data collection; paseo-bm never writes into a skills directory.",
  ];
}

/** Builds the skills step with replaceable dependencies. */
export function createSkillsAssistStep(deps: SkillsAssistDeps = {}): SkillsStep {
  const runner = deps.runner ?? runSkillsCommand;
  const timers = deps.timers ?? realTimers;
  const signals = deps.signals ?? (process as unknown as SignalSource);
  const clock = deps.now ?? (() => new Date());
  return (input) => assist(input, {
    runner,
    timers,
    signals,
    clock,
    timeoutMs: deps.timeoutMs ?? SKILLS_TIMEOUT_MS,
    silenceWarningMs: deps.silenceWarningMs ?? SKILLS_SILENCE_WARNING_MS,
    killGraceMs: deps.killGraceMs ?? SKILLS_KILL_GRACE_MS,
  });
}

interface ResolvedDeps {
  readonly runner: SkillsRunner;
  readonly timers: SkillsTimers;
  readonly signals: SignalSource;
  readonly clock: () => Date;
  readonly timeoutMs: number;
  readonly silenceWarningMs: number;
  readonly killGraceMs: number;
}

async function assist(input: SkillsStepInput, deps: ResolvedDeps): Promise<SkillsStepOutcome> {
  const { context } = input;
  const flags = context.flags;
  if (flags.skipSkillsCheck) {
    return { skills: null, warnings: [], notes: [] };
  }

  const agents = context.skillsAgents;
  const command = skillsAddCommand(agents);
  const commandText = formatSkillsCommand(command);
  const before = await detectSkills(input.layout);
  const missingBefore = hasMissingRequiredSkills(before);
  const notes: string[] = [];

  const report = (detection: SkillsDetection, ran: SkillsAssistOutcome | undefined): SkillsReport => ({
    source: SKILLS_SOURCE,
    required: detection.required,
    byAgent: toSkillsByAgent(detection),
    suggestedCommand: hasMissingRequiredSkills(detection) ? commandText : null,
    assisted: ran !== undefined ? true : input.record?.skills.lastCommand != null,
    outcome: ran !== undefined ? ran : (input.record?.skills.assistOutcome ?? null),
  });
  const missingWarning = (detection: SkillsDetection): SkillsStepOutcome["warnings"] => {
    const detail = missingSkillsDetail(detection);
    return detail === null ? [] : [{ code: "W_SKILLS_MISSING", detail }];
  };

  /* -- preview: observe only ------------------------------------------- */
  if (!input.apply) {
    if (missingBefore) notes.push(...manualInstructions(commandText));
    return { skills: report(before, undefined), warnings: missingWarning(before), notes };
  }

  /* -- the record: every write is best effort ------------------------------ */
  let record = input.record;
  const persist = async (patch: Partial<SkillsRecord>): Promise<void> => {
    if (record === undefined) return;
    const skills: SkillsRecord = { ...record.skills, ...patch };
    if (JSON.stringify(skills) === JSON.stringify(record.skills)) return;
    const next: InstallRecord = touchRecord({ ...record, skills }, deps.clock());
    try {
      await writeRecord(createFsOps({ root: input.layout.installHome.path, fs: input.fs }), next);
      record = next;
    } catch (error) {
      notes.push(`Could not update install.json with the skills result: ${error instanceof Error ? error.message : String(error)}.`);
    }
  };

  let declinedAt = record?.skills.assistDeclinedAt ?? null;
  if (flags.askSkillsAgain && declinedAt !== null) {
    declinedAt = null;
    await persist({ assistDeclinedAt: null });
    notes.push("The remembered answer for the skills step was cleared (--ask-skills-again).");
  }

  if (!missingBefore) {
    await persist({ agents: [...agents], lastStatus: lastStatusOf(before) });
    return { skills: report(before, undefined), warnings: [], notes };
  }

  /* -- consent ------------------------------------------------------------ */
  let consent = flags.installSkills;
  if (consent) {
    notes.push("Consent to run the skills CLI given with --install-skills.");
  } else if (declinedAt !== null) {
    notes.push(
      `You chose not to run the skills CLI on ${declinedAt}; paseo-bm will not ask again until you pass --ask-skills-again.`,
      ...manualInstructions(commandText),
    );
  } else if (input.interactive) {
    consent = await context.prompter.confirm({
      message: SKILLS_QUESTION,
      defaultValue: false,
      details: [
        `Missing: ${summary(before)}.`,
        "paseo-bm can run the third-party skills CLI for you. It downloads the skills from GitHub and links them",
        `into the agents' skills directories. Target agents: ${agents.join(", ")}. The exact command:`,
        `  ${commandText}`,
        "paseo-bm cannot uninstall skills afterwards; use the skills CLI itself for that.",
      ],
    });
    if (!consent) {
      const at = toIsoUtc(deps.clock());
      await persist({ agents: [...agents], lastStatus: lastStatusOf(before), assistDeclinedAt: at });
      notes.push(...manualInstructions(commandText), "paseo-bm will not ask again; pass --ask-skills-again to be asked.");
    }
  } else {
    notes.push(...manualInstructions(commandText), "Without a terminal, pass --install-skills to let paseo-bm run it.");
  }

  if (!consent) {
    if (declinedAt !== null || !input.interactive) {
      await persist({ agents: [...agents], lastStatus: lastStatusOf(before) });
    }
    return { skills: report(before, undefined), warnings: missingWarning(before), notes };
  }

  /* -- run ---------------------------------------------------------------- */
  const redact = createRedactor({ env: context.env });
  const toStdout = flags.json ? context.stderr : context.stdout;
  context.stderr(`Running: ${commandText}\n`);

  let result: SkillsRunResult;
  try {
    result = await deps.runner(command, {
      env: context.env as NodeJS.ProcessEnv,
      timeoutMs: deps.timeoutMs,
      silenceWarningMs: deps.silenceWarningMs,
      killGraceMs: deps.killGraceMs,
      timers: deps.timers,
      signals: deps.signals,
      onStdout: (chunk) => {
        toStdout(redact(chunk));
      },
      onStderr: (chunk) => {
        context.stderr(redact(chunk));
      },
      onSilence: (ms) => {
        context.stderr(
          `The skills CLI has printed nothing for ${String(ms / 1000)} seconds; still waiting ` +
            `(it is stopped after ${String(deps.timeoutMs / 1000)} seconds).\n`,
        );
      },
    });
  } catch {
    result = { outcome: "failed", reason: "spawn-failed", exitCode: null, signal: null };
  }

  /* -- detect again, record, report ---------------------------------------- */
  const after = await detectSkills(input.layout);
  const outcome: Exclude<SkillsAssistOutcome, null> = result.outcome;
  await persist({
    agents: [...agents],
    lastStatus: lastStatusOf(after),
    lastCommand: commandText,
    assistOutcome: outcome,
  });

  notes.push(`Skills before: ${summary(before)}.`, `Skills after: ${summary(after)}.`);
  const warnings = [...missingWarning(after)];
  if (result.outcome === "interrupted") {
    notes.push("The skills CLI was interrupted. To run it again:", `  ${commandText}`);
  } else if (result.outcome === "failed") {
    const why = describeFailure(result);
    warnings.push({ code: "W_SKILLS_ASSIST_FAILED", detail: `\`${commandText}\` did not succeed: ${why}.` });
    notes.push(`The skills CLI did not succeed: ${why}.`, ...manualInstructions(commandText));
  }
  return { skills: report(after, outcome), warnings, notes };
}

/** The step `install` uses once it is wired in place of `detectOnlySkills`. */
export const assistSkills: SkillsStep = createSkillsAssistStep();
