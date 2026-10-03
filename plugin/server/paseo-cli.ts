/**
 * The two `paseo` CLI commands the plugin runs (delta 20260918 §4.1).
 *
 * The plugin SDK cannot change an existing agent's mode or labels:
 * `PaseoAgentHandle` has no setter for either, `DaemonClient.setAgentMode` is
 * not handed to plugins, and `before("agent.session_open")` only edits `env`
 * (N2, N3). Paseo CLI 0.8 can: `paseo agent mode <id> <mode>` and
 * `paseo agent update <id> --label <k=v>`. The binary is found the way the
 * Settings find `br` (`findTool`), and run the way it runs one: `execFile`,
 * never a shell, with a timeout.
 *
 * Every argument is checked before it reaches the command line. A value that
 * starts with `-` would be read as a flag, so ids, modes and labels must start
 * with a letter or digit and hold nothing but the characters Paseo uses.
 *
 * Since spike S5 (ADR-027; run note
 * `docs/archive/operations/paseo-bm-agent-tools-spikes-20261003.md` §4) the
 * plugin also cancels an agent's running turn: `paseo agent stop <id> --json`
 * (`cancelAgent`). That command also takes an id PREFIX, `--all` and `--cwd`,
 * so only a whole agent id (a UUID) is ever passed, and never those flags.
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

/** Runs `paseo <args>` and keeps its output on success. */
async function runPaseoOutput(args: string[], deps: PaseoCliDeps): Promise<{ ok: true; output: string } | { ok: false; reason: string }> {
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
  return { ok: true, output: outcome.output };
}

async function runPaseo(args: string[], deps: PaseoCliDeps): Promise<CliResult> {
  const result = await runPaseoOutput(args, deps);
  return result.ok ? { ok: true } : result;
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

/** Paseo's longest explicit agent title (`MAX_EXPLICIT_AGENT_TITLE_CHARS`, 0.9.2). */
export const MAX_AGENT_TITLE_CHARS = 200;

/**
 * `paseo agent update <id> --name <title> --json`: Paseo sets the agent's
 * title from `--name`. A title that would be read as a flag, is blank, holds a
 * line break or is longer than Paseo allows is refused.
 */
export function setAgentTitle(agentId: string, title: string, deps: PaseoCliDeps = {}): Promise<CliResult> {
  if (!isSafeAgentId(agentId)) return Promise.resolve({ ok: false, reason: `refusing an unexpected agent id "${agentId}"` });
  if (title.trim() === "" || title.startsWith("-") || /[\r\n]/.test(title) || title.length > MAX_AGENT_TITLE_CHARS) {
    return Promise.resolve({ ok: false, reason: "refusing an unexpected title" });
  }
  return runPaseo(["agent", "update", agentId, "--name", title, "--json"], deps);
}

/**
 * `paseo agent update <id> --label <k>=<v> [--label <k>=<v> …] --json`: one
 * command for several labels. Paseo adds or sets each label and removes none
 * (`paseo agent update --help`, 0.8.0). Every key and value is checked first.
 */
export function setAgentLabels(agentId: string, labels: Readonly<Record<string, string>>, deps: PaseoCliDeps = {}): Promise<CliResult> {
  if (!isSafeAgentId(agentId)) return Promise.resolve({ ok: false, reason: `refusing an unexpected agent id "${agentId}"` });
  const entries = Object.entries(labels);
  if (entries.length === 0) return Promise.resolve({ ok: false, reason: "no label to set" });
  const args = ["agent", "update", agentId];
  for (const [key, value] of entries) {
    if (!TOKEN.test(key) || !TOKEN.test(value)) {
      return Promise.resolve({ ok: false, reason: `refusing an unexpected label "${key}=${value}"` });
    }
    args.push("--label", `${key}=${value}`);
  }
  args.push("--json");
  return runPaseo(args, deps);
}

/**
 * A whole Paseo agent id: a UUID. `paseo agent stop` matches an id PREFIX too
 * (spike S5), so anything shorter could stop agents the plugin never meant.
 */
const FULL_AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isFullAgentId(id: string): boolean {
  return FULL_AGENT_ID.test(id) && isSafeAgentId(id);
}

/**
 * The outcome of a cancel: `stopped` says whether the agent had a running turn
 * that the command ended (`false`: it was idle, and the command was a no-op).
 */
export type CancelResult = { ok: true; stopped: boolean } | { ok: false; reason: string };

/** The `agentIds` of `paseo agent stop --json` (`{"stoppedCount": n, "agentIds": [...]}`), or null when unreadable. */
function stoppedIdsOf(output: string): string[] | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as { agentIds?: unknown };
    return Array.isArray(parsed.agentIds) ? parsed.agentIds.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
}

/**
 * `paseo agent stop <id> --json`: cancels the agent's running turn, as the
 * owner's Stop does (the turn ends `canceled`, reason `Interrupted`); a no-op
 * for an idle agent. Verified from the daemon process by spike S5: the daemon
 * and every other agent are untouched.
 *
 * Only a whole agent id is passed (`isFullAgentId`), never `--all` or `--cwd`.
 * A command that reports stopping any other agent is a failure, named in the
 * reason. Never throws.
 */
export async function cancelAgent(agentId: string, deps: PaseoCliDeps = {}): Promise<CancelResult> {
  if (!isFullAgentId(agentId)) return { ok: false, reason: `refusing an agent id that is not a whole id "${agentId}"` };
  const result = await runPaseoOutput(["agent", "stop", agentId, "--json"], deps);
  if (!result.ok) return result;
  const ids = stoppedIdsOf(result.output);
  if (ids === null) return { ok: true, stopped: false };
  const others = ids.filter((id) => id !== agentId);
  if (others.length > 0) return { ok: false, reason: `\`paseo agent stop\` also stopped ${others.join(", ")}` };
  return { ok: true, stopped: ids.includes(agentId) };
}
