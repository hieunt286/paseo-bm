/**
 * The two `paseo` CLI commands the plugin runs (delta 20260918 §4.1).
 *
 * The plugin SDK cannot change an existing agent's mode or labels:
 * `PaseoAgentHandle` has no setter for either, `DaemonClient.setAgentMode` is
 * not handed to plugins, and `before("agent.session_open")` only edits `env`
 * (N2, N3). Paseo CLI 0.8 can: `paseo agent mode <id> <mode>` and
 * `paseo agent update <id> --label <k=v>`. The binary is found the way the
 * Setup screen finds `br` (`findTool`), and run the way it runs one: `execFile`,
 * never a shell, with a timeout.
 *
 * Every argument is checked before it reaches the command line. A value that
 * starts with `-` would be read as a flag, so ids, modes and labels must start
 * with a letter or digit and hold nothing but the characters Paseo uses.
 */
import { execFile } from "node:child_process";
import { findTool } from "./setup-tools";

/** How long one CLI call may take before it counts as failed. */
export const CLI_TIMEOUT_MS = 5000;

/** An agent id as Paseo mints it: never a flag, never a path. */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** A mode id, a label key or a label value: never a flag, no `=` or spaces. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface CliOutcome {
  code: number;
  output: string;
  timedOut: boolean;
}

export type CliRunner = (file: string, args: string[], timeoutMs: number) => Promise<CliOutcome>;

export interface PaseoCliDeps {
  /** Runs the binary. Tests pass a fake; nothing in a test may start the real `paseo`. */
  run?: CliRunner;
  /** Finds the `paseo` binary, or `null`. */
  find?: () => string | null;
}

export type CliResult = { ok: true } | { ok: false; reason: string };

export function isSafeAgentId(id: string): boolean {
  return AGENT_ID.test(id);
}

function runExecFile(file: string, args: string[], timeoutMs: number): Promise<CliOutcome> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const failure = error as (Error & { code?: unknown; killed?: boolean }) | null;
      const code = failure === null ? 0 : typeof failure.code === "number" ? failure.code : 1;
      resolve({ code, output: `${stdout}${stderr}`, timedOut: failure?.killed === true });
    });
  });
}

/** The first non-empty line of the CLI's output, short enough for a notice. */
function firstLine(output: string): string {
  const line = output.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

async function runPaseo(args: string[], deps: PaseoCliDeps): Promise<CliResult> {
  const binary = (deps.find ?? (() => findTool("paseo")))();
  if (binary === null) return { ok: false, reason: "the `paseo` command was not found" };
  let outcome: CliOutcome;
  try {
    outcome = await (deps.run ?? runExecFile)(binary, args, CLI_TIMEOUT_MS);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (outcome.timedOut) return { ok: false, reason: `\`paseo ${args.slice(0, 2).join(" ")}\` took longer than ${CLI_TIMEOUT_MS} ms` };
  if (outcome.code !== 0) {
    const detail = firstLine(outcome.output);
    return { ok: false, reason: `\`paseo ${args.slice(0, 2).join(" ")}\` exited with ${outcome.code}${detail === "" ? "" : `: ${detail}`}` };
  }
  return { ok: true };
}

/** `paseo agent mode <id> <mode> --json`. */
export function setAgentMode(agentId: string, modeId: string, deps: PaseoCliDeps = {}): Promise<CliResult> {
  if (!isSafeAgentId(agentId)) return Promise.resolve({ ok: false, reason: `refusing an unexpected agent id "${agentId}"` });
  if (!TOKEN.test(modeId)) return Promise.resolve({ ok: false, reason: `refusing an unexpected mode "${modeId}"` });
  return runPaseo(["agent", "mode", agentId, modeId, "--json"], deps);
}

/** `paseo agent update <id> --label <key>=<value> --json`. */
export function setAgentLabel(agentId: string, key: string, value: string, deps: PaseoCliDeps = {}): Promise<CliResult> {
  if (!isSafeAgentId(agentId)) return Promise.resolve({ ok: false, reason: `refusing an unexpected agent id "${agentId}"` });
  if (!TOKEN.test(key) || !TOKEN.test(value)) {
    return Promise.resolve({ ok: false, reason: `refusing an unexpected label "${key}=${value}"` });
  }
  return runPaseo(["agent", "update", agentId, "--label", `${key}=${value}`, "--json"], deps);
}
