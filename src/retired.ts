/**
 * What the `paseo-bm` command used to do, and where each job went
 * (Technical Design §4.2; ADR-012 decision 7).
 *
 * 0.4.0 is the command's last version and does exactly one thing: move a 0.3.x
 * directory install to the npm plugin. Everything else it used to do now
 * belongs to the plugin, which can do it while it runs and with the user
 * watching.
 *
 * A retired command does not fail silently or print "unknown command": someone
 * typing `paseo-bm doctor` has a question, and the answer is a sentence saying
 * where to look. That is the whole purpose of this module (REQ-070 f).
 */

/** Diagnostic code every retirement reports, with exit code 2. */
export const RETIRED_CODE = "E_COMMAND_RETIRED";

export interface Retirement {
  /** What the user typed. */
  readonly name: string;
  /** Where the job went, in one sentence. */
  readonly replacement: string;
}

/** Subcommands that no longer exist. */
export const RETIRED_COMMANDS: Readonly<Record<string, string>> = {
  doctor:
    "Open Beads Manager → Setup: it shows the roles, Paseo's agent tools, sign-in, skills, `br` and `bv`, and the data folder. If the plugin does not load at all, run `paseo plugin ls` and `paseo plugin logs paseo-bm`.",
  uninstall:
    'Open Beads Manager → Setup and press "Remove paseo-bm\'s settings", then run `paseo plugin remove paseo-bm`.',
};

/** Flags that no longer exist, and what replaced each. */
export const RETIRED_FLAGS: Readonly<Record<string, string>> = {
  "--enable-plugins":
    'Paseo\'s plugins switch is Paseo\'s own. Paseo\'s agent tools are granted by "Allow agent tools…" on Setup, which asks first and records what the switch was.',
  "--install-skills": 'Press "Install skills…" on Setup: it shows the exact command before running it.',
  "--install-beads-tools": "Install `br` and `bv` from Setup → Beads tools.",
  "--skills-agents": "Setup installs the skills for Claude Code and Codex; there is nothing to choose.",
  "--role": "Choose each role's provider and model in Setup → Agents.",
  "--reconfigure": "Change the roles in Setup → Agents.",
  "--skip-skills-check": "Setup shows the skills and never installs them without a press.",
  "--force": "Nothing is overwritten any more: the plugin only creates entries that are missing.",
  "--ask-skills-again": 'Press "Install skills…" on Setup whenever you want to.',
  "--restore-backups": "The plugin takes no backups: it writes Paseo's configuration through Paseo's own API.",
  "--prune": "Old payload versions are Paseo's to manage now. `~/.paseo-bm/plugin/` can be deleted by hand after migrating.",
  "--claude-home": "Setup reads the skills directories itself; there is nothing to point it at.",
  "--codex-home": "Setup reads the skills directories itself; there is nothing to point it at.",
};

/** The message a retired command or flag prints, in full. */
export function retirementMessage(retirement: Retirement): string {
  return `${retirement.name} was retired in paseo-bm 0.4.0. ${retirement.replacement}`;
}

/** The retirement for a command name, or `undefined` when it still exists. */
export function retiredCommand(name: string): Retirement | undefined {
  const replacement = RETIRED_COMMANDS[name];
  return replacement === undefined ? undefined : { name: `\`paseo-bm ${name}\``, replacement };
}

/**
 * The retirement `argv` asks about, or `undefined`.
 *
 * Read straight from argv, before anything is parsed, so a retired flag gets
 * its sentence even when the rest of the line makes no sense in 0.4.0 either —
 * `--role worker=codex/gpt-5` would otherwise be answered with a complaint
 * about the value of a flag that no longer exists.
 */
export function retirementIn(argv: readonly string[]): Retirement | undefined {
  const command = argv.find((argument) => !argument.startsWith("-"));
  return (command === undefined ? undefined : retiredCommand(command)) ?? retiredFlagIn(argv);
}

/**
 * The first retired flag in `argv`, or `undefined`.
 *
 * Reads argv rather than the parsed flags so a flag that was removed from the
 * parser is still recognised: to a user, `--role` not existing and `--role`
 * being retired look the same until one of them explains itself.
 */
export function retiredFlagIn(argv: readonly string[]): Retirement | undefined {
  for (const argument of argv) {
    if (argument === "--") break;
    const flag = argument.startsWith("--") ? (argument.split("=")[0] ?? argument) : null;
    if (flag === null) continue;
    const replacement = RETIRED_FLAGS[flag];
    if (replacement !== undefined) return { name: `\`${flag}\``, replacement };
  }
  return undefined;
}
