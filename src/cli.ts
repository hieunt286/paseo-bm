/**
 * Command-line layer: parse, render help, detect TTY, hand a validated context
 * to a command handler. Command behaviour lives in its own modules; this file
 * owns routing and nothing else, so the install / doctor / uninstall flows can
 * be developed and tested independently of argv handling.
 */
import {
  COMMAND_SPECS,
  EXIT_CODES,
  EXIT_CODE_SPECS,
  FLAG_SPECS,
  parseCommandLine,
  homeFlagOverrides,
} from "./flags.js";
import type {
  CommandName,
  Environment,
  Flags,
  FlagSpec,
  HomeOverrides,
  UsageError,
} from "./flags.js";
import { createPrompter, detectTty } from "./prompter.js";
import type { Prompter, TtyInfo } from "./prompter.js";
import { RETIRED_CODE, RETIRED_FLAGS, retirementIn, retirementMessage } from "./retired.js";
import { readVersion } from "./version.js";

export type Writer = (text: string) => void;

/** Everything a command handler is allowed to know about its invocation. */
export interface CommandContext {
  readonly command: CommandName;
  /** False for a bare `paseo-bm`: run the wizard on a TTY, preview otherwise. */
  readonly explicitCommand: boolean;
  readonly flags: Flags;
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

  // Before parsing: 0.4.0 only migrates (ADR-012 decision 7), and someone who
  // typed `doctor` or `--role` deserves the sentence that says where the job
  // went — not a complaint about the value of a flag that no longer exists.
  const retired = retirementIn(argv);
  if (retired !== undefined) {
    reportUsageError(stderr, { code: RETIRED_CODE, message: retirementMessage(retired) });
    return EXIT_CODES.usage;
  }

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

  const prompter = (deps.createPrompter ?? ((info: TtyInfo) => createPrompter(info)))(tty);
  const context: CommandContext = {
    command: parsed.command,
    explicitCommand: parsed.explicitCommand,
    flags: parsed.flags,
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
 * that carries a registry code prints it, so `E_COMMAND_RETIRED` is visible to
 * a reader and greppable in a transcript.
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
    lines.push("  npx paseo-bm [options]");
    lines.push("");
    lines.push("paseo-bm 0.4.0 does one thing: it moves an install made by an earlier");
    lines.push("`npx paseo-bm` to the plugin on npm, keeping your roles, settings and");
    lines.push("history. It is the last version of this command.");
    lines.push("");
    lines.push("Everything else paseo-bm used to do is in the plugin itself:");
    lines.push("  Install      from paseo.cafe, or `paseo plugin add npm:paseo-bm-plugin`");
    lines.push("  Set up       Beads Manager → Setup");
    lines.push("  Health       Beads Manager → Setup, or `paseo plugin logs paseo-bm`");
    lines.push("  Remove       Setup → \"Remove paseo-bm's settings\", then");
    lines.push("               `paseo plugin remove paseo-bm`");
    lines.push("");
    lines.push("Without --apply it only previews; on a terminal it asks first.");
    lines.push("");
    lines.push("Options:");
    for (const spec of FLAG_SPECS) {
      if (RETIRED_FLAGS[spec.flag] === undefined) lines.push(...renderFlag(spec, true));
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
      if (spec.commands.includes(topic) && RETIRED_FLAGS[spec.flag] === undefined) {
        lines.push(...renderFlag(spec, false));
      }
    }
  }

  lines.push(`  ${"-h, --help".padEnd(FLAG_COLUMN)}Show this message`);
  lines.push(`  ${"-v, --version".padEnd(FLAG_COLUMN)}Print the version and exit`);
  lines.push("");
  lines.push("--yes only skips the apply confirmation. Nothing here grants any consent:");
  lines.push("the switches paseo-bm used to ask about are buttons on Setup now.");
  lines.push("");
  lines.push("Exit codes:");
  for (const spec of EXIT_CODE_SPECS) {
    if (spec.code === EXIT_CODES.doctorDrift || spec.code === EXIT_CODES.consentMissing) continue;
    lines.push(`  ${String(spec.code).padEnd(4)}${spec.meaning}`);
  }
  lines.push("");
  return lines.join("\n");
}

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
