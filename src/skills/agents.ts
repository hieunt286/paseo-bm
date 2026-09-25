/**
 * `--skills-agents` validation (REQ-007(d), Design §4.2 · §4.3).
 *
 * The list the user types here ends up as arguments of an external command —
 * the third-party `skills` CLI. That is why it is judged at argument-parsing
 * time, before preflight and before anything is written, and why the rules are
 * strict: every element must be a plain lowercase name, and an element that
 * starts with `-` is refused outright so nobody can smuggle an extra flag into
 * that command.
 *
 * A failure here is a command-line misuse: `E_BAD_SKILLS_AGENTS`, exit code 2.
 * Runtime failures of the skills step itself (CLI missing, non-zero exit,
 * timeout, no network) are a different thing and never change the exit code.
 */

import { diagnostic } from "../errors.js";
import type { UsageError } from "../flags.js";

/** What `--skills-agents` means when it is not given (Design §4.2). */
export const DEFAULT_SKILLS_AGENTS: readonly string[] = ["claude", "codex"];

/** The longest list accepted (Design §4.2). */
export const MAX_SKILLS_AGENTS = 8;

/** One agent name (Design §4.2). The first character can never be `-`. */
export const SKILLS_AGENT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export type SkillsAgentsResult =
  | { readonly ok: true; readonly agents: readonly string[] }
  | { readonly ok: false; readonly error: UsageError };

function badList(value: string, why: string): UsageError {
  const entry = diagnostic("E_BAD_SKILLS_AGENTS");
  return {
    code: entry.code,
    message: `--skills-agents ${value}: ${why}.`,
    hint: entry.remediation,
  };
}

/** Keep an absurd value out of the error message while still showing the start of it. */
function clip(value: string): string {
  return value.length <= 60 ? value : `${value.slice(0, 57)}...`;
}

/**
 * Take `--skills-agents` apart. Syntax only, no I/O: whether an agent is
 * actually installed is detection's business (`src/skills/detect.ts`).
 *
 * A name given twice is rejected rather than silently collapsed, so a typo such
 * as `claude,claude` (meant `claude,codex`) is surfaced instead of hidden.
 */
export function parseSkillsAgents(value: string | undefined): SkillsAgentsResult {
  if (value === undefined) {
    return { ok: true, agents: DEFAULT_SKILLS_AGENTS };
  }

  const shown = clip(value);
  const elements = value.split(",").map((element) => element.trim());
  if (elements.length > MAX_SKILLS_AGENTS) {
    return {
      ok: false,
      error: badList(
        shown,
        `${String(elements.length)} agents were given; at most ${String(MAX_SKILLS_AGENTS)} are allowed`,
      ),
    };
  }

  const agents: string[] = [];
  for (const element of elements) {
    if (element.length === 0) {
      return { ok: false, error: badList(shown, "the list has an empty element") };
    }
    if (element.startsWith("-")) {
      return {
        ok: false,
        error: badList(shown, `"${clip(element)}" starts with "-", which could be read as a flag`),
      };
    }
    if (!SKILLS_AGENT_PATTERN.test(element)) {
      return {
        ok: false,
        error: badList(
          shown,
          `"${clip(element)}" is not an agent name (lowercase letters, digits, "_" and "-", at most 32 characters)`,
        ),
      };
    }
    if (agents.includes(element)) {
      return { ok: false, error: badList(shown, `"${element}" is given more than once`) };
    }
    agents.push(element);
  }
  return { ok: true, agents };
}
