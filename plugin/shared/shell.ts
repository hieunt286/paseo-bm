/**
 * Reading the shell commands agents ran. One place, because two modules asked
 * the same question ("did this `br` command act on beads?") with two different
 * rules and could disagree about the same line. `shared/`, so the metrics
 * (`eval-metrics.ts`) read a line as the server's bead readers do (code review
 * 2026-09-30 §3.5): no Node and no React Native imports.
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

/**
 * Where a `br reopen` starts in a command, global flags between `br` and
 * `reopen` allowed (`br --db x reopen …`). Not global, so `test` keeps no
 * state; a reader of every match makes its own global copy.
 */
export const BR_REOPEN = /\bbr(?:\s+-{1,2}[\w-]+(?:[= ]\S+)?)*\s+reopen\b/;

/**
 * A shell command as two readers compare it (the Worker watch's `failing`, a
 * report's named checks in `evidence.ts`): trimmed, runs of white space made
 * one space.
 */
export function normalisedCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * How a shell call failed, for the Worker watch's `failing`: its non-zero exit
 * code, "failed" when the entry only says so, or null when it did not fail.
 * Paseo's timeline for a Claude Worker carries no `exitCode` — a failed call is
 * `status: "failed"` with no output (coordination run 2026-09-29, F1) — so the
 * status counts as well as a non-zero numeric exit code. Pure.
 */
export function shellFailureOf(status: string | null, exitCode: unknown): number | "failed" | null {
  if (typeof exitCode === "number" && exitCode !== 0) return exitCode;
  if (status === "failed" || status === "error") return "failed";
  return null;
}

/**
 * True when a shell call ended well (autonomy design §C.6, corrected from the
 * shapes captured at §C.1): an exit code, when the entry has one, decides — 0
 * is success whatever the status, and anything else is not, since OpenCode
 * reports a failing command as `completed` with a non-zero code. Without one,
 * only `status: "completed"` is (Claude reports a failure as `failed`). A call
 * still running, or one that says neither, did not succeed. Pure.
 */
export function shellSucceeded(status: string | null | undefined, exitCode: number | null | undefined): boolean {
  if (typeof exitCode === "number") return exitCode === 0;
  return status === "completed";
}

/**
 * The commands of a shell line whose exit status vouches for every one of
 * them: the `&&` segments of a line joined only by `&&` (one segment for a
 * plain command), as written, trimmed. Such a line succeeds only when each
 * segment does. Null for a line also joined by `;`, `||`, `|`, a lone `&` or a
 * new line: it ends as its last part does (`npm test | tail -5` succeeds when
 * `tail` does), so its status proves nothing about the others (autonomy design
 * §C.6, change-008 C5). Joins inside quotes are not joins, as in
 * `commandSegments`; a `\`-continued line is one line; `2>&1` and `&>` are
 * redirections, not joins. Null too for an empty segment. Pure.
 */
export function andChainOf(line: string): string[] | null {
  const joined = line.replace(/\\\r?\n/g, "  ");
  // Quoted arguments blanked to as many spaces, so positions still index `joined`.
  const bare = joined.replace(/'[^']*'|"[^"]*"/g, (quoted) => " ".repeat(quoted.length));
  if (/[;\r\n|]/.test(bare) || /(?<![&<>])&(?![&>])/.test(bare)) return null;
  const segments: string[] = [];
  let start = 0;
  for (let at = bare.indexOf("&&"); at !== -1; at = bare.indexOf("&&", start)) {
    segments.push(joined.slice(start, at).trim());
    start = at + 2;
  }
  segments.push(joined.slice(start).trim());
  return segments.some((segment) => segment === "") ? null : segments;
}

// ---------------------------------------------------------------------------
// The commands of a shell line, as the action boundary reads them (autonomy
// design §D.2, change-009 C5): each simple command of `&&`, `||`, `;`, `|`,
// `&` and new lines, with its words unquoted, its leading assignments and its
// redirections apart, and the bodies of `$(…)` and `` `…` `` read as commands
// of their own. Here-document bodies are text, not commands, and are dropped.
// A reader, not a shell: it never expands a variable or a glob.
// ---------------------------------------------------------------------------

/** One word of a command, unquoted. */
export interface ShellWord {
  /** The word without its quotes; an expansion (`$d`, `${d}`, `$(…)`) is kept as written. */
  value: string;
  /** True when part of the word is an expansion the shell fills in: a variable, `$(…)` or `` `…` ``. */
  dynamic: boolean;
  /** The bodies of the `$(…)` and `` `…` `` in the word, in order. */
  substitutions: string[];
}

/** One simple command of a line. */
export interface ShellCommand {
  /** The `NAME=value` words before the program. */
  assignments: Array<{ name: string; value: ShellWord }>;
  /** The program and its arguments; empty for a command of assignments or redirections only. */
  words: ShellWord[];
  /** Output redirections (`>`, `>>`, `>|`, `&>`, `2>`) and their target; input and fd duplications are left out. */
  writes: ShellWord[];
  /** The command's own text, quotes included (for the SQL a database CLI is given). */
  text: string;
}

export interface ParsedShellLine {
  /** Every simple command, in the order they appear; those of a substitution come right after the command holding it. */
  commands: ShellCommand[];
  /** True when a quote or a substitution was left open: the line cannot be read as the shell would. */
  unbalanced: boolean;
}

const SHELL_KEYWORDS: ReadonlySet<string> = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "in", "case", "esac", "!", "{", "}", "time"]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** The line without here-document bodies: each `<<WORD` drops the lines after it up to the one that is `WORD`. */
function withoutHereDocuments(line: string): string {
  const lines = line.split("\n");
  const kept: string[] = [];
  const pending: Array<{ word: string; strip: boolean }> = [];
  for (const current of lines) {
    if (pending.length > 0) {
      const next = pending[0]!;
      if ((next.strip ? current.replace(/^\t+/, "") : current) === next.word) pending.shift();
      continue;
    }
    kept.push(current);
    // The markers of this line, outside single quotes (a rough read: enough for `cat > f <<'EOF'`).
    const bare = current.replace(/'[^']*'(?!\w)/g, (quoted) => (/^'[A-Za-z_][\w-]*'$/.test(quoted) ? quoted : " ".repeat(quoted.length)));
    for (const match of bare.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/g)) pending.push({ word: match[3]!, strip: match[1] === "-" });
  }
  return kept.join("\n");
}

/** The body of a `$(…)` starting at `open` (the index of its `(`), and the index after its `)`; null when it never closes. */
function substitutionAt(text: string, open: number): { body: string; end: number } | null {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "'") {
      const close = text.indexOf("'", index + 1);
      if (close < 0) return null;
      index = close;
      continue;
    }
    if (char === '"') {
      let at = index + 1;
      while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
      if (at >= text.length) return null;
      index = at;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, index), end: index + 1 };
    }
  }
  return null;
}

/**
 * Reads a shell line into its simple commands (see `ParsedShellLine`). Pure;
 * never throws. Nested substitutions are read to any depth.
 */
export function parseShellLine(line: string): ParsedShellLine {
  const text = withoutHereDocuments(line);
  const commands: ShellCommand[] = [];
  let unbalanced = false;

  let words: ShellWord[] = [];
  let writes: ShellWord[] = [];
  let pendingSubs: string[] = [];
  let start = 0;
  let word: ShellWord | null = null;
  let wordQuoted = false;
  /** What the next word is: an output target, a word to drop (input, here-document marker), or an argument. */
  let next: "write" | "skip" | "word" = "word";

  const flushWord = () => {
    if (word === null) return;
    const done = word;
    word = null;
    const quoted = wordQuoted;
    wordQuoted = false;
    if (next === "write") writes.push(done);
    else if (next === "word" && (quoted || done.value !== "")) words.push(done);
    next = "word";
  };
  const flushCommand = (end: number) => {
    flushWord();
    next = "word";
    // Keywords of compound commands are not programs.
    while (words.length > 0 && SHELL_KEYWORDS.has(words[0]!.value) && !words[0]!.dynamic) words.shift();
    const assignments: ShellCommand["assignments"] = [];
    while (words.length > 0) {
      const match = ASSIGNMENT.exec(words[0]!.value);
      if (match === null) break;
      const first = words.shift()!;
      assignments.push({ name: match[1]!, value: { ...first, value: first.value.slice(match[0].length) } });
    }
    // `export NAME=…`, `local NAME=…`, `declare NAME=…` assign too.
    if (words.length > 1 && ["export", "local", "declare", "readonly", "typeset"].includes(words[0]!.value)) {
      const rest = words.slice(1).filter((entry) => !entry.value.startsWith("-"));
      if (rest.every((entry) => ASSIGNMENT.test(entry.value) || /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.value))) {
        for (const entry of rest) {
          const match = ASSIGNMENT.exec(entry.value);
          if (match !== null) assignments.push({ name: match[1]!, value: { ...entry, value: entry.value.slice(match[0].length) } });
        }
        words = [];
      }
    }
    const body = text.slice(start, end).trim();
    if (words.length > 0 || writes.length > 0 || assignments.length > 0) commands.push({ assignments, words, writes, text: body });
    for (const sub of pendingSubs) {
      const inner = parseShellLine(sub);
      if (inner.unbalanced) unbalanced = true;
      commands.push(...inner.commands);
    }
    words = [];
    writes = [];
    pendingSubs = [];
  };
  const current = (): ShellWord => (word ??= { value: "", dynamic: false, substitutions: [] });
  const addSubstitution = (body: string, written: string) => {
    const target = current();
    target.value += written;
    target.dynamic = true;
    target.substitutions.push(body);
    pendingSubs.push(body);
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const after = text[index + 1];
    // Single quotes: everything literal.
    if (char === "'") {
      const close = text.indexOf("'", index + 1);
      if (close < 0) {
        unbalanced = true;
        current().value += text.slice(index + 1);
        break;
      }
      current().value += text.slice(index + 1, close);
      wordQuoted = true;
      index = close + 1;
      continue;
    }
    // Double quotes: escapes, variables and substitutions still count.
    if (char === '"') {
      wordQuoted = true;
      const target = current();
      let at = index + 1;
      let closed = false;
      while (at < text.length) {
        const inner = text[at]!;
        if (inner === '"') {
          closed = true;
          break;
        }
        if (inner === "\\" && at + 1 < text.length && '"\\$`\n'.includes(text[at + 1]!)) {
          if (text[at + 1] !== "\n") target.value += text[at + 1];
          at += 2;
          continue;
        }
        if (inner === "$" && text[at + 1] === "(") {
          const sub = substitutionAt(text, at + 1);
          if (sub === null) {
            unbalanced = true;
            at = text.length;
            break;
          }
          if (!sub.body.startsWith("(")) addSubstitution(sub.body, text.slice(at, sub.end));
          else {
            target.value += text.slice(at, sub.end);
            target.dynamic = true;
          }
          at = sub.end;
          continue;
        }
        if (inner === "`") {
          const close = text.indexOf("`", at + 1);
          if (close < 0) {
            unbalanced = true;
            at = text.length;
            break;
          }
          addSubstitution(text.slice(at + 1, close), text.slice(at, close + 1));
          at = close + 1;
          continue;
        }
        if (inner === "$" && /[A-Za-z_{@*#?0-9]/.test(text[at + 1] ?? "")) target.dynamic = true;
        target.value += inner;
        at += 1;
      }
      if (!closed) unbalanced = true;
      index = at + 1;
      continue;
    }
    if (char === "\\") {
      if (after === "\n") index += 2;
      else {
        if (after !== undefined) current().value += after;
        index += 2;
      }
      continue;
    }
    if (char === "#" && word === null) {
      const newline = text.indexOf("\n", index);
      index = newline < 0 ? text.length : newline;
      continue;
    }
    if (char === "$" && after === "(") {
      const sub = substitutionAt(text, index + 1);
      if (sub === null) {
        unbalanced = true;
        break;
      }
      // `$((…))` is arithmetic, not a command.
      if (!sub.body.startsWith("(")) addSubstitution(sub.body, text.slice(index, sub.end));
      else {
        current().value += text.slice(index, sub.end);
        current().dynamic = true;
      }
      index = sub.end;
      continue;
    }
    if (char === "`") {
      const close = text.indexOf("`", index + 1);
      if (close < 0) {
        unbalanced = true;
        break;
      }
      addSubstitution(text.slice(index + 1, close), text.slice(index, close + 1));
      index = close + 1;
      continue;
    }
    if (char === "$" && /[A-Za-z_{@*#?0-9]/.test(after ?? "")) {
      current().value += char;
      current().dynamic = true;
      index += 1;
      continue;
    }
    // Redirections: `>`, `>>`, `>|`, `&>`, `n>`; `>&n` and inputs name no file written.
    if (char === ">" || (char === "&" && after === ">") || char === "<") {
      // `word` is set by the closures above, which the compiler does not follow.
      const pending = word as ShellWord | null;
      const fd = pending !== null && !wordQuoted && /^\d+$/.test(pending.value) && !pending.dynamic;
      if (fd) {
        word = null;
        wordQuoted = false;
      } else flushWord();
      let at = char === "&" ? index + 1 : index;
      const input = text[at] === "<";
      at += 1;
      while (text[at] === ">" || text[at] === "<" || text[at] === "|") at += 1;
      if (text[at] === "&") {
        // A duplication (`2>&1`, `>&-`): its target is a descriptor.
        at += 1;
        while (at < text.length && /[\d-]/.test(text[at]!)) at += 1;
        next = "word";
      } else next = input ? "skip" : "write";
      index = at;
      continue;
    }
    const operator = /^(?:&&|\|\||;;|[;&|\n()])/.exec(text.slice(index));
    if (operator !== null) {
      flushCommand(index);
      index += operator[0].length;
      start = index;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      flushWord();
      index += 1;
      continue;
    }
    current().value += char;
    index += 1;
  }
  flushCommand(text.length);
  return { commands, unbalanced };
}
