/**
 * Installing the beads tools `br` (beads_rust) and `bv` (beads_viewer) during
 * `install` (delta 20260916-setup-screen §3.5, owner decision 2026-09-16:
 * "khi cài thì tự cài").
 *
 * - On a terminal, a missing tool is installed as part of the changes the user
 *   applies: the preview names the exact commands before "Apply these
 *   changes?", so no extra question is asked (M-1 stays at three).
 * - Without a terminal, only with `--install-beads-tools`.
 * - Homebrew when it is on PATH (`brew install dicklesworthstone/tap/<tool>`),
 *   otherwise the project's own install script: `br` with `--skip-skills`, so
 *   paseo-bm still never causes writes into a skills directory, and `bv`
 *   pinned to the commit its README names.
 *
 * Like the skills step, nothing here throws into the install flow or changes
 * its exit code: a failure is a warning plus the manual command.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReportWarning } from "./action.js";
import type { CommandContext } from "./cli.js";
import { findExecutableOnPath, type FsProbe } from "./preflight.js";
import { createRedactor } from "./redact.js";
import {
  SKILLS_KILL_GRACE_MS,
  SKILLS_SILENCE_WARNING_MS,
  realTimers,
  runSkillsCommand,
  type SignalSource,
  type SkillsCommand,
  type SkillsRunResult,
  type SkillsRunner,
  type SkillsTimers,
} from "./skills/assist.js";

export const BEADS_TOOLS = ["br", "bv"] as const;
export type BeadsTool = (typeof BEADS_TOOLS)[number];

/** Deadline for one tool install. */
export const BEADS_TOOL_TIMEOUT_MS = 300_000;

export const BEADS_TOOL_SCRIPTS: Readonly<Record<BeadsTool, string>> = {
  br: "curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh | bash -s -- --skip-skills",
  bv: "curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/beads_viewer/a43b8e85a39664381566abdfd85dc8fcbfdcb773/install.sh | bash",
};

/** The warning each tool raises in preflight, cleared once the tool is installed. */
const MISSING_WARNING: Readonly<Record<BeadsTool, ReportWarning["code"]>> = {
  br: "W_BEADS_CLI_MISSING",
  bv: "W_BEADS_VIEWER_MISSING",
};

export interface BeadsToolPlan {
  readonly tool: BeadsTool;
  readonly command: SkillsCommand;
  /** What the user reads; for a script, exactly the script line that runs. */
  readonly text: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** `br` counts as present only as `br` itself: the Worker's instructions use `br`. */
export function missingBeadsTools(env: Env, fs?: FsProbe): BeadsTool[] {
  return BEADS_TOOLS.filter((tool) => findExecutableOnPath(tool, { env, ...(fs === undefined ? {} : { fs }) }) === null);
}

export function planBeadsTools(missing: readonly BeadsTool[], env: Env, fs?: FsProbe): BeadsToolPlan[] {
  const brew = findExecutableOnPath("brew", { env, ...(fs === undefined ? {} : { fs }) });
  return missing.map((tool) =>
    brew !== null
      ? {
          tool,
          command: { executable: brew, args: ["install", `dicklesworthstone/tap/${tool}`] },
          text: `brew install dicklesworthstone/tap/${tool}`,
        }
      : { tool, command: { executable: "/bin/bash", args: ["-c", BEADS_TOOL_SCRIPTS[tool]] }, text: BEADS_TOOL_SCRIPTS[tool] },
  );
}

/** The lines shown under the preview on a terminal. */
export function beadsToolsPreviewLines(plans: readonly BeadsToolPlan[]): string[] {
  if (plans.length === 0) return [];
  return [
    `Missing beads tools (${plans.map((plan) => plan.tool).join(", ")}) will be installed when you apply these changes:`,
    ...plans.map((plan) => `  ${plan.text}`),
  ];
}

export interface BeadsToolsStepInput {
  readonly context: CommandContext;
  readonly interactive: boolean;
  readonly apply: boolean;
}

export interface BeadsToolsStepOutcome {
  readonly warnings: ReportWarning[];
  readonly notes: string[];
  /** Tools that were missing and are there now: their preflight warnings no longer apply. */
  readonly resolvedWarnings: ReportWarning["code"][];
}

export type BeadsToolsStep = (input: BeadsToolsStepInput) => Promise<BeadsToolsStepOutcome>;

export interface BeadsToolsDeps {
  readonly runner?: SkillsRunner;
  readonly timers?: SkillsTimers;
  readonly signals?: SignalSource;
  readonly fs?: FsProbe;
  readonly homedir?: () => string;
  readonly timeoutMs?: number;
}

function manual(plans: readonly BeadsToolPlan[]): string[] {
  return ["To install the missing beads tools yourself, run:", ...plans.map((plan) => `  ${plan.text}`)];
}

function why(result: SkillsRunResult): string {
  if (result.outcome === "interrupted") return "it was interrupted";
  if (result.outcome !== "failed") return "";
  switch (result.reason) {
    case "not-found":
      return "the installer could not be found";
    case "spawn-failed":
      return "the command could not be started";
    case "timeout":
      return `it did not finish within ${String(BEADS_TOOL_TIMEOUT_MS / 1000)} seconds and was stopped`;
    case "exit-code":
      return result.signal !== null ? `it was terminated by ${result.signal}` : `it exited with code ${String(result.exitCode)}`;
  }
}

export function createBeadsToolsStep(deps: BeadsToolsDeps = {}): BeadsToolsStep {
  const runner = deps.runner ?? runSkillsCommand;
  return async ({ context, interactive, apply }) => {
    const env = context.env;
    const missing = missingBeadsTools(env, deps.fs);
    const notes: string[] = [];
    if (missing.length === 0) return { warnings: [], notes, resolvedWarnings: [] };
    const plans = planBeadsTools(missing, env, deps.fs);
    const consent = context.flags.installBeadsTools || interactive;

    if (!apply || !consent) {
      notes.push(...manual(plans));
      if (!consent) notes.push("Without a terminal, pass --install-beads-tools to let paseo-bm install them.");
      return { warnings: [], notes, resolvedWarnings: [] };
    }

    const redact = createRedactor({ env });
    const toStdout = context.flags.json ? context.stderr : context.stdout;
    const warnings: ReportWarning[] = [];
    const resolvedWarnings: ReportWarning["code"][] = [];
    // A script installs into ~/.local/bin, which may not be on this PATH yet.
    const localBin = join((deps.homedir ?? homedir)(), ".local", "bin");
    const afterEnv: Env = { ...env, PATH: [env.PATH ?? "", localBin].filter((part) => part !== "").join(":") };

    for (const plan of plans) {
      context.stderr(`Installing ${plan.tool}: ${plan.text}\n`);
      let result: SkillsRunResult;
      try {
        result = await runner(plan.command, {
          env: env as NodeJS.ProcessEnv,
          timeoutMs: deps.timeoutMs ?? BEADS_TOOL_TIMEOUT_MS,
          silenceWarningMs: SKILLS_SILENCE_WARNING_MS,
          killGraceMs: SKILLS_KILL_GRACE_MS,
          timers: deps.timers ?? realTimers,
          signals: deps.signals ?? (process as unknown as SignalSource),
          onStdout: (chunk) => toStdout(redact(chunk)),
          onStderr: (chunk) => context.stderr(redact(chunk)),
          onSilence: (ms) => context.stderr(`The ${plan.tool} installer has printed nothing for ${String(ms / 1000)} seconds; still waiting.\n`),
        });
      } catch {
        result = { outcome: "failed", reason: "spawn-failed", exitCode: null, signal: null };
      }
      const found = findExecutableOnPath(plan.tool, { env: afterEnv, ...(deps.fs === undefined ? {} : { fs: deps.fs }) });
      if (result.outcome === "ok" && found !== null) {
        resolvedWarnings.push(MISSING_WARNING[plan.tool]);
        notes.push(`Installed ${plan.tool} at ${found}.`);
        if (found.startsWith(localBin) && findExecutableOnPath(plan.tool, { env, ...(deps.fs === undefined ? {} : { fs: deps.fs }) }) === null) {
          notes.push(`${localBin} is not on your PATH yet; add it so agents can run ${plan.tool}.`);
        }
      } else {
        const reason = result.outcome === "ok" ? `it finished but \`${plan.tool}\` is still not on PATH` : why(result);
        warnings.push({ code: "W_BEADS_TOOLS_INSTALL_FAILED", detail: `\`${plan.text}\` did not install ${plan.tool}: ${reason}.` });
        notes.push(...manual([plan]));
      }
    }
    return { warnings, notes, resolvedWarnings };
  };
}

export const installBeadsTools: BeadsToolsStep = createBeadsToolsStep();
