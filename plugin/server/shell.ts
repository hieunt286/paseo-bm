/**
 * Reading the shell commands agents ran. One place, because two modules asked
 * the same question ("did this `br` command act on beads?") with two different
 * rules and could disagree about the same line.
 *
 * All three rules below were found on real agent output (WP-214 acceptance).
 */
import { BEAD_ID } from "./bm-report";

/**
 * Splits a shell line into the commands it runs, with quoted arguments blanked:
 * `grep -iE 'makefile|pytest'` contains pipes and a runner's name inside the
 * quotes, and must not look like two commands, one of them a test run.
 */
export function commandSegments(line: string): string[] {
  return line
    .replace(/'[^']*'|"[^"]*"/g, " ARG ")
    .split(/&&|\|\||[;\n|]/)
    .map((segment) => segment.trim().replace(/^[(\s]+/, ""))
    .filter((segment) => segment !== "");
}

export type BrVerb = "create" | "update" | "close";

export interface BrAction {
  verb: BrVerb;
  ids: string[];
  /** An update that moves its beads to `in_progress` (`--status in_progress` or `--claim`). */
  startsWork: boolean;
}

function startsWork(tokens: readonly string[]): boolean {
  return tokens.some(
    (token, index) =>
      token === "--claim" ||
      token === "--status=in_progress" ||
      ((token === "--status" || token === "-s") && tokens[index + 1] === "in_progress"),
  );
}

/**
 * The `br create | update | close` commands in a shell line that actually act.
 *
 * - A `--help`, `-h` or `--dry-run` command only looked (a Worker ran
 *   `br create --help` to orient itself, and the beads step read as done).
 * - Bead ids are positional arguments only, read before the first flag.
 *   Scanning the whole line read `-l "feature:format-date"` and the prose of
 *   `-r "… a single-line docstring …"` as ids: one request reported 6 closed
 *   beads instead of 1.
 * - `br create` names no id at all: `br` mints it.
 */
export function brActions(line: string): BrAction[] {
  const out: BrAction[] = [];
  for (const segment of commandSegments(line)) {
    const match = /^br\s+(create|update|close)\b(.*)$/i.exec(segment);
    if (match === null) continue;
    const tokens = match[2]!.trim().split(/\s+/).filter((token) => token !== "");
    if (tokens.some((token) => token === "--help" || token === "-h" || token === "--dry-run")) continue;
    const ids: string[] = [];
    for (const token of tokens) {
      if (token.startsWith("-")) break;
      if (BEAD_ID.test(token)) ids.push(token);
    }
    const verb = match[1]!.toLowerCase() as BrVerb;
    out.push({ verb, ids, startsWork: verb === "update" && startsWork(tokens) });
  }
  return out;
}
