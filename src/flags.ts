/**
 * Command and flag registry — the single source of truth for the command-line
 * contract in Technical Design §4.1 (commands) and §4.2 (flags); the exit-code
 * table of §4.3 is owned by `./exit-codes.ts` and re-exported below for
 * convenience. Nothing here executes a command; it only turns argv into a validated,
 * typed shape, or into a usage error that the caller reports with exit code 2.
 */

import type { ErrorCode } from "./errors.js";

/**
 * Exit codes live in `./exit-codes.ts` (Technical Design §4.3) and are
 * re-exported here so that the command-line contract can be imported from one
 * module. There is deliberately no second copy of the table: two copies drift.
 */
export { EXIT_CODES, EXIT_CODE_SPECS, exitCodeMeaning, isExitCode, previewExitCode } from "./exit-codes.js";
export type { ExitCode, ExitCodeName, ExitCodeSpec, PreviewSituation } from "./exit-codes.js";

/** Executable commands. Design §4.1 also lists `configure`, which is Phase 2. */
export const COMMANDS = ["install", "doctor", "uninstall"] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface CommandSpec {
  readonly name: CommandName;
  readonly summary: string;
}

export const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: "install", summary: "Install or update paseo-bm (without --apply: asks before writing on a terminal, preview only otherwise)" },
  { name: "doctor", summary: "Read-only health check; never writes anything" },
  { name: "uninstall", summary: "Remove what paseo-bm owns (preview only without --apply)" },
];

const ALL_COMMANDS: readonly CommandName[] = COMMANDS;

/** Parsed, typed flag values. One field per row of Design §4.2. */
export interface Flags {
  readonly apply: boolean;
  readonly yes: boolean;
  readonly enablePlugins: boolean;
  readonly installSkills: boolean;
  readonly installBeadsTools: boolean;
  readonly skillsAgents: string | undefined;
  /**
   * Raw `<role>=<provider>/<model>` strings, in the order they were typed. The
   * syntax is checked by `parseRoleSpecs()` in `src/roles/config.ts`, which
   * `runCli()` runs immediately after parsing.
   */
  readonly role: readonly string[];
  readonly reconfigure: boolean;
  readonly skipSkillsCheck: boolean;
  readonly force: boolean;
  readonly askSkillsAgain: boolean;
  readonly restoreBackups: boolean;
  readonly prune: boolean;
  readonly home: string | undefined;
  readonly paseoHome: string | undefined;
  readonly claudeHome: string | undefined;
  readonly codexHome: string | undefined;
  readonly json: boolean;
  readonly verbose: boolean;
}

export type FlagKey = keyof Flags;
export type FlagKind = "boolean" | "value" | "repeatable";

export interface FlagSpec {
  /** The flag as typed, including the leading dashes. */
  readonly flag: string;
  readonly key: FlagKey;
  readonly kind: FlagKind;
  /** Commands this flag is accepted on. Using it elsewhere is exit code 2. */
  readonly commands: readonly CommandName[];
  readonly valueLabel?: string;
  /** Environment variable consulted when the flag is absent (flag > env > default). */
  readonly env?: string;
  readonly summary: string;
}

/** Design §4.2, in table order. Adding, renaming or dropping a row changes a published contract. */
export const FLAG_SPECS: readonly FlagSpec[] = [
  {
    flag: "--apply",
    key: "apply",
    kind: "boolean",
    commands: ["install", "uninstall"],
    summary: "Actually write; without it the command only previews",
  },
  {
    flag: "--yes",
    key: "yes",
    kind: "boolean",
    commands: ["install", "uninstall"],
    summary: "Skip the apply confirmation; never implies consent to any trust boundary",
  },
  {
    flag: "--enable-plugins",
    key: "enablePlugins",
    kind: "boolean",
    commands: ["install"],
    summary: "Consent to both halves of one trust boundary: enable pluginsEnabled and grant Paseo tools to agents",
  },
  {
    flag: "--install-skills",
    key: "installSkills",
    kind: "boolean",
    commands: ["install"],
    summary: "Consent to running the third-party skills CLI",
  },
  {
    flag: "--install-beads-tools",
    key: "installBeadsTools",
    kind: "boolean",
    commands: ["install"],
    summary: "Consent to installing missing br and bv without a terminal (a terminal install does it anyway)",
  },
  {
    flag: "--skills-agents",
    key: "skillsAgents",
    kind: "value",
    commands: ["install", "doctor"],
    valueLabel: "<list>",
    summary: "Target agents for the skills CLI (default claude,codex)",
  },
  {
    flag: "--role",
    key: "role",
    kind: "repeatable",
    commands: ["install"],
    valueLabel: "<role>=<provider>/<model>",
    summary: "Pick the tool for a role; repeatable",
  },
  {
    flag: "--reconfigure",
    key: "reconfigure",
    kind: "boolean",
    commands: ["install"],
    summary: "Ask the full role configuration again even when it already exists",
  },
  {
    flag: "--skip-skills-check",
    key: "skipSkillsCheck",
    kind: "boolean",
    commands: ["install", "doctor"],
    summary: "Skip the skills step entirely",
  },
  {
    flag: "--force",
    key: "force",
    kind: "boolean",
    commands: ["install", "uninstall"],
    summary: "Install: overwrite user-modified files. Uninstall: delete them too",
  },
  {
    flag: "--ask-skills-again",
    key: "askSkillsAgain",
    kind: "boolean",
    commands: ["install"],
    summary: "Clear the remembered \"do not ask again\" answer for the skills step",
  },
  {
    flag: "--restore-backups",
    key: "restoreBackups",
    kind: "boolean",
    commands: ["uninstall"],
    summary: "Restore backups before removing",
  },
  {
    flag: "--prune",
    key: "prune",
    kind: "boolean",
    commands: ["install"],
    summary: "Clean up old payloads and backups; only on request",
  },
  {
    flag: "--home",
    key: "home",
    kind: "value",
    commands: ALL_COMMANDS,
    valueLabel: "<dir>",
    env: "PASEO_BM_HOME",
    summary: "paseo-bm install home",
  },
  {
    flag: "--paseo-home",
    key: "paseoHome",
    kind: "value",
    commands: ALL_COMMANDS,
    valueLabel: "<dir>",
    env: "PASEO_HOME",
    summary: "Paseo home directory",
  },
  {
    flag: "--claude-home",
    key: "claudeHome",
    kind: "value",
    commands: ALL_COMMANDS,
    valueLabel: "<dir>",
    env: "CLAUDE_CONFIG_DIR",
    summary: "Claude Code config directory used when detecting skills",
  },
  {
    flag: "--codex-home",
    key: "codexHome",
    kind: "value",
    commands: ALL_COMMANDS,
    valueLabel: "<dir>",
    env: "CODEX_HOME",
    summary: "Codex config directory used when detecting skills",
  },
  {
    flag: "--json",
    key: "json",
    kind: "boolean",
    commands: ALL_COMMANDS,
    summary: "Emit exactly one JSON document on stdout",
  },
  {
    flag: "--verbose",
    key: "verbose",
    kind: "boolean",
    commands: ALL_COMMANDS,
    summary: "Print more detail about each step",
  },
];

const HELP_FLAGS = new Set(["--help", "-h"]);
const VERSION_FLAGS = new Set(["--version", "-v"]);

const SPEC_BY_FLAG = new Map<string, FlagSpec>(FLAG_SPECS.map((spec) => [spec.flag, spec]));

/** A misuse of the command line. Always reported with exit code 2. */
export interface UsageError {
  readonly message: string;
  readonly hint?: string;
  /**
   * Registry code, when the misuse has one — `E_BAD_ROLE_SPEC` for a malformed
   * `--role`. Plain argv mistakes (an unknown flag, a missing value) have no
   * code and leave this undefined.
   */
  readonly code?: ErrorCode;
}

export interface ParsedCommandLine {
  /** The command to run. A bare `paseo-bm` resolves to the install wizard. */
  readonly command: CommandName;
  /** False when the user typed no command, i.e. the bare wizard invocation. */
  readonly explicitCommand: boolean;
  readonly help: boolean;
  readonly version: boolean;
  /** Command whose help was requested, when `--help` followed a command. */
  readonly helpTopic: CommandName | undefined;
  readonly flags: Flags;
}

export type ParseResult =
  | { readonly ok: true; readonly parsed: ParsedCommandLine }
  | { readonly ok: false; readonly error: UsageError };

type RawValue = boolean | string | string[];

/**
 * Turn argv (already stripped of `node` and the script path) into a validated
 * command line.
 *
 * Value formats such as `--role` and `--skills-agents` are *not* checked here.
 * They are still checked at parse time — `runCli()` runs them the moment this
 * function returns, before preflight and before anything is written — but they
 * live in their own modules (`src/roles/config.ts` for `--role`) so that this
 * one stays a pure argv-to-shape function with no knowledge of roles,
 * providers or agents.
 */
export function parseCommandLine(argv: readonly string[]): ParseResult {
  const meta = scanForHelp(argv);
  if (meta !== undefined) {
    return { ok: true, parsed: meta };
  }

  const raw = new Map<FlagKey, RawValue>();
  let command: CommandName | undefined;
  let explicitCommand = false;
  let positionalsOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (token === "--") {
      positionalsOnly = true;
      continue;
    }

    if (!positionalsOnly && token.startsWith("-") && token !== "-") {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token : token.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);
      const spec = SPEC_BY_FLAG.get(name);
      if (spec === undefined) {
        return fail(`Unknown flag ${name}.`, "Run `paseo-bm --help` to see every command and flag.");
      }

      if (spec.kind === "boolean") {
        if (inlineValue !== undefined) {
          return fail(`Flag ${spec.flag} does not take a value.`);
        }
        raw.set(spec.key, true);
        continue;
      }

      let value = inlineValue;
      if (value === undefined) {
        const next = argv[index + 1];
        if (next === undefined || (next.startsWith("-") && next !== "-")) {
          return fail(
            `Flag ${spec.flag} requires a value.`,
            `Write ${spec.flag}=<value> when the value itself starts with "-".`,
          );
        }
        value = next;
        index += 1;
      }
      if (value === "") {
        return fail(`Flag ${spec.flag} requires a non-empty value.`);
      }

      if (spec.kind === "repeatable") {
        const previous = raw.get(spec.key);
        const list = Array.isArray(previous) ? previous : [];
        list.push(value);
        raw.set(spec.key, list);
      } else {
        // Last occurrence wins, the usual CLI convention.
        raw.set(spec.key, value);
      }
      continue;
    }

    if (command !== undefined || explicitCommand) {
      return fail(`Unexpected argument "${token}".`, "paseo-bm takes at most one command.");
    }
    if (!isCommandName(token)) {
      return fail(
        `Unknown command "${token}".`,
        `Known commands: ${COMMANDS.join(", ")}.`,
      );
    }
    command = token;
    explicitCommand = true;
  }

  // A bare `paseo-bm` is the install wizard, so install owns flag applicability.
  const effective: CommandName = command ?? "install";

  for (const spec of FLAG_SPECS) {
    if (!raw.has(spec.key)) {
      continue;
    }
    if (spec.commands.includes(effective)) {
      continue;
    }
    const where = explicitCommand ? `\`paseo-bm ${effective}\`` : "the bare `paseo-bm` wizard, which runs install";
    return fail(
      `Flag ${spec.flag} is not valid for ${where}.`,
      `${spec.flag} applies to: ${spec.commands.join(", ")}.`,
    );
  }

  return {
    ok: true,
    parsed: {
      command: effective,
      explicitCommand,
      help: false,
      version: false,
      helpTopic: undefined,
      flags: assemble(raw),
    },
  };
}

/**
 * `--help` and `--version` short-circuit before any other validation, so
 * `paseo-bm uninstall --help` explains uninstall instead of complaining about
 * whatever else is on the line.
 */
function scanForHelp(argv: readonly string[]): ParsedCommandLine | undefined {
  let help = false;
  let version = false;
  let topic: CommandName | undefined;
  for (const token of argv) {
    if (HELP_FLAGS.has(token)) {
      help = true;
    } else if (VERSION_FLAGS.has(token)) {
      version = true;
    } else if (topic === undefined && isCommandName(token)) {
      topic = token;
    }
  }
  if (!help && !version) {
    return undefined;
  }
  return {
    command: topic ?? "install",
    explicitCommand: topic !== undefined,
    help,
    // `--help` wins when both are present: it is the more informative answer.
    version: version && !help,
    helpTopic: help ? topic : undefined,
    flags: assemble(new Map()),
  };
}

export function isCommandName(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

function fail(message: string, hint?: string): ParseResult {
  return { ok: false, error: hint === undefined ? { message } : { message, hint } };
}

function assemble(raw: ReadonlyMap<FlagKey, RawValue>): Flags {
  return {
    apply: readBoolean(raw, "apply"),
    yes: readBoolean(raw, "yes"),
    enablePlugins: readBoolean(raw, "enablePlugins"),
    installSkills: readBoolean(raw, "installSkills"),
    installBeadsTools: readBoolean(raw, "installBeadsTools"),
    skillsAgents: readValue(raw, "skillsAgents"),
    role: readList(raw, "role"),
    reconfigure: readBoolean(raw, "reconfigure"),
    skipSkillsCheck: readBoolean(raw, "skipSkillsCheck"),
    force: readBoolean(raw, "force"),
    askSkillsAgain: readBoolean(raw, "askSkillsAgain"),
    restoreBackups: readBoolean(raw, "restoreBackups"),
    prune: readBoolean(raw, "prune"),
    home: readValue(raw, "home"),
    paseoHome: readValue(raw, "paseoHome"),
    claudeHome: readValue(raw, "claudeHome"),
    codexHome: readValue(raw, "codexHome"),
    json: readBoolean(raw, "json"),
    verbose: readBoolean(raw, "verbose"),
  };
}

function readBoolean(raw: ReadonlyMap<FlagKey, RawValue>, key: FlagKey): boolean {
  return raw.get(key) === true;
}

function readValue(raw: ReadonlyMap<FlagKey, RawValue>, key: FlagKey): string | undefined {
  const value = raw.get(key);
  return typeof value === "string" ? value : undefined;
}

function readList(raw: ReadonlyMap<FlagKey, RawValue>, key: FlagKey): readonly string[] {
  const value = raw.get(key);
  return Array.isArray(value) ? value : [];
}

/** Directory overrides that any command may need. */
export interface HomeOverrides {
  readonly home: string | undefined;
  readonly paseoHome: string | undefined;
  readonly claudeHome: string | undefined;
  readonly codexHome: string | undefined;
}

export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Apply the precedence rule of Design §4.2: flag > environment variable >
 * default. Resolving these into real paths (and rejecting dangerous ones) is a
 * different concern and lives outside this module.
 */
// Only the flag layer. Environment variables and defaults are resolved by
// resolveLayout() in src/layout.ts, which is the single owner of the
// flag > env > daemon > default precedence contract (REQ-014c).
export function homeFlagOverrides(flags: Flags): HomeOverrides {
  return {
    home: flags.home,
    paseoHome: flags.paseoHome,
    claudeHome: flags.claudeHome,
    codexHome: flags.codexHome,
  };
}
