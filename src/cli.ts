/**
 * Command-line layer: parse, render help, detect TTY, hand a validated context
 * to a command handler. Command behaviour lives in its own modules; this file
 * owns routing and nothing else, so the install / doctor / uninstall flows can
 * be developed and tested independently of argv handling.
 */
import {
  COMMAND_SPECS,
  EXIT_CODES,
  FLAG_SPECS,
  parseCommandLine,
  homeFlagOverrides,
} from "./flags.js";
import type {
  CommandName,
  Environment,
  ExitCode,
  Flags,
  FlagSpec,
  HomeOverrides,
  UsageError,
} from "./flags.js";
import { createPrompter, detectTty } from "./prompter.js";
import type { Prompter, TtyInfo } from "./prompter.js";
import { parseRoleSpecs } from "./roles/config.js";
import { parseSkillsAgents } from "./skills/agents.js";
import type { RoleSpec } from "./roles/config.js";
import { readVersion } from "./version.js";

export type Writer = (text: string) => void;

/** Everything a command handler is allowed to know about its invocation. */
export interface CommandContext {
  readonly command: CommandName;
  /** False for a bare `paseo-bm`: run the wizard on a TTY, preview otherwise. */
  readonly explicitCommand: boolean;
  readonly flags: Flags;
  /**
   * `--role` after its syntax has been checked (Design §7). Empty when the
   * flag was not used. Whether each provider and model actually exists is a
   * separate, later check against Paseo — see `src/roles/config.ts`.
   */
  readonly roleSpecs: readonly RoleSpec[];
  /**
   * `--skills-agents` after validation (Design §7), or the default
   * `claude,codex` when the flag was not used.
   */
  readonly skillsAgents: readonly string[];
  readonly homes: HomeOverrides;
  readonly tty: TtyInfo;
  readonly prompter: Prompter;
  readonly stdout: Writer;
  readonly stderr: Writer;
  readonly env: Environment;
  readonly version: string;
}

export type CommandHandler = (context: CommandContext) => Promise<number> | number;

export type CommandHandlers = {
  readonly [K in CommandName]: CommandHandler;
};

export interface CliDependencies {
  readonly handlers: CommandHandlers;
  readonly stdout?: Writer;
  readonly stderr?: Writer;
  readonly env?: Environment;
  readonly tty?: TtyInfo;
  /** Overridden in tests with a scripted prompter. */
  readonly createPrompter?: (tty: TtyInfo) => Prompter;
  readonly version?: string;
}

/**
 * Run the CLI and return the process exit code.
 *
 * Every dependency that touches the outside world is injectable so the whole
 * layer is testable without a terminal, and so a command handler never reaches
 * for `process` on its own.
 */
export async function runCli(argv: readonly string[], deps: CliDependencies): Promise<number> {
  const stdout = deps.stdout ?? ((text) => void process.stdout.write(text));
  const stderr = deps.stderr ?? ((text) => void process.stderr.write(text));
  const env = deps.env ?? process.env;
  const tty = deps.tty ?? detectTty();
  const version = deps.version ?? readVersion();

  const result = parseCommandLine(argv);
  if (!result.ok) {
    reportUsageError(stderr, result.error);
    return EXIT_CODES.usage;
  }

  const { parsed } = result;
  if (parsed.help) {
    stdout(renderHelp(parsed.helpTopic));
    return EXIT_CODES.ok;
  }
  if (parsed.version) {
    stdout(`${version}\n`);
    return EXIT_CODES.ok;
  }

  // Value-format checks belong here, not inside `parseCommandLine`: Design §7
  // requires them at parse time, before preflight and before anything is
  // written, and doing them after the parser keeps the parser free of any
  // knowledge about roles and providers. Only the syntax is judged now; the
  // existence of a provider/model pair needs a daemon and is checked later
  // with `E_PROVIDER_UNAVAILABLE`.
  const roles = parseRoleSpecs(parsed.flags.role);
  if (!roles.ok) {
    reportUsageError(stderr, roles.error);
    return EXIT_CODES.usage;
  }
  const skillsAgents = parseSkillsAgents(parsed.flags.skillsAgents);
  if (!skillsAgents.ok) {
    reportUsageError(stderr, skillsAgents.error);
    return EXIT_CODES.usage;
  }

  const prompter = (deps.createPrompter ?? ((info: TtyInfo) => createPrompter(info)))(tty);
  const context: CommandContext = {
    command: parsed.command,
    explicitCommand: parsed.explicitCommand,
    flags: parsed.flags,
    roleSpecs: roles.specs,
    skillsAgents: skillsAgents.agents,
    homes: homeFlagOverrides(parsed.flags),
    tty,
    prompter,
    stdout,
    stderr,
    env,
    version,
  };

  try {
    return await deps.handlers[parsed.command](context);
  } finally {
    await prompter.close();
  }
}

/**
 * Write a misuse message the same way for every cause of exit code 2. A misuse
 * that carries a registry code prints it, so `E_BAD_ROLE_SPEC` is visible to a
 * reader and greppable in a transcript.
 */
export function reportUsageError(stderr: Writer, error: UsageError): void {
  const prefix = error.code === undefined ? "error:" : `error: ${error.code}:`;
  stderr(`${prefix} ${error.message}\n`);
  if (error.hint !== undefined) {
    stderr(`${error.hint}\n`);
  }
}

const SYNOPSIS = "paseo-bm — Beads Management for Paseo";

/**
 * Render help. Without a topic it lists every command and every flag, so
 * `--help` alone is a complete description of the contract in Design §4.2.
 */
export function renderHelp(topic?: CommandName): string {
  const lines: string[] = [SYNOPSIS, ""];

  if (topic === undefined) {
    lines.push("Usage:");
    lines.push("  npx paseo-bm [command] [options]");
    lines.push("");
    lines.push("Running paseo-bm with no command starts the install wizard on a terminal,");
    lines.push("and prints a preview without writing anything when there is no terminal.");
    lines.push("");
    lines.push("Commands:");
    for (const command of COMMAND_SPECS) {
      lines.push(`  ${command.name.padEnd(COMMAND_COLUMN)}${command.summary}`);
    }
    lines.push("");
    lines.push("install and uninstall only preview their work; pass --apply to write.");
    lines.push("");
    lines.push("Options:");
    for (const spec of FLAG_SPECS) {
      lines.push(...renderFlag(spec, true));
    }
  } else {
    lines.push("Usage:");
    lines.push(`  npx paseo-bm ${topic} [options]`);
    lines.push("");
    const summary = COMMAND_SPECS.find((command) => command.name === topic)?.summary;
    if (summary !== undefined) {
      lines.push(summary);
      lines.push("");
    }
    lines.push("Options:");
    for (const spec of FLAG_SPECS) {
      if (spec.commands.includes(topic)) {
        lines.push(...renderFlag(spec, false));
      }
    }
  }

  lines.push(`  ${"-h, --help".padEnd(FLAG_COLUMN)}Show this message`);
  lines.push(`  ${"-v, --version".padEnd(FLAG_COLUMN)}Print the version and exit`);
  lines.push("");
  lines.push("--yes only skips the apply confirmation. It never grants consent to enable");
  lines.push("plugins, to open Paseo tool access for agents, or to run the skills CLI.");
  lines.push("");
  lines.push("Exit codes:");
  for (const [code, meaning] of EXIT_CODE_MEANINGS) {
    lines.push(`  ${String(code).padEnd(4)}${meaning}`);
  }
  lines.push("");
  return lines.join("\n");
}

const COMMAND_COLUMN = 12;
const FLAG_COLUMN = 34;

function renderFlag(spec: FlagSpec, showCommands: boolean): string[] {
  const invocation = spec.valueLabel === undefined ? spec.flag : `${spec.flag} ${spec.valueLabel}`;
  const lines = [`  ${invocation.padEnd(FLAG_COLUMN)}${spec.summary}`];
  const notes: string[] = [];
  if (showCommands) {
    notes.push(`applies to: ${spec.commands.join(", ")}`);
  }
  if (spec.env !== undefined) {
    notes.push(`env: ${spec.env}`);
  }
  if (notes.length > 0) {
    lines.push(`  ${"".padEnd(FLAG_COLUMN)}(${notes.join("; ")})`);
  }
  return lines;
}

const EXIT_CODE_MEANINGS: readonly (readonly [ExitCode, string])[] = [
  [EXIT_CODES.ok, "success, an intentional preview, or a healthy doctor"],
  [EXIT_CODES.doctorDrift, "doctor found drift in what paseo-bm owns"],
  [EXIT_CODES.usage, "misuse of a command or flag"],
  [EXIT_CODES.preflight, "environment precondition failed; nothing was written"],
  [EXIT_CODES.consentMissing, "installed, but a trust boundary was not consented to"],
  [EXIT_CODES.conflict, "stopped on a conflict that needs a human decision"],
  [EXIT_CODES.noTtyNoApply, "no terminal and no --apply; preview printed, nothing written"],
];
