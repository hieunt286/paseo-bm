/**
 * The effectful actions a shell command can run (Orchestrator design §6B.3
 * `danger`; evaluation design §4, A-6): the one list, its shell patterns, the
 * effects a grant must hold to cover each action, and the judge of an
 * `rm -rf` target (code review 2026-09-30 §3.5). The Worker watch raises its
 * `danger` signal on them (`server/worker-watch.ts` `dangerOfCommand`) and A-6
 * counts them (`eval-metrics.ts`), so the two read a command the same way.
 *
 * Paths are read POSIX style. This module is `shared/`: no Node and no React
 * Native imports.
 */
import { GATE_CATEGORIES, GATE_CATEGORY_EFFECTS, gateMatchesOf, type GateCategory } from "./decision-gate";
import { classOfEffects, realEffects, type DecisionClass, type Effect } from "./decisions";
import { hereDocumentsOf, parseShellLine, withoutHereDocuments, type ShellCommand, type ShellWord } from "./shell";

/** The actions, in the order A-6 reports them; each is also the name the `danger` evidence gives, but `rm -rf`, which names its target. */
export const EFFECTFUL_ACTIONS = [
  "git push",
  "glab mr create/update",
  "glab mr merge",
  "gh pr create/edit",
  "gh pr merge",
  "npm publish",
  "pnpm publish",
  "yarn publish",
  "kubectl apply/delete",
  "terraform apply/destroy",
  "helm install/upgrade/uninstall",
  "vercel --prod",
  "docker push",
  "DROP TABLE/DATABASE",
  "TRUNCATE",
  "DELETE FROM without WHERE",
  "rm -rf outside the workspace",
] as const;
export type EffectfulAction = (typeof EFFECTFUL_ACTIONS)[number];

/** The actions a pattern names; `DELETE FROM` without `WHERE` and `rm -rf` are read by hand below. */
const EFFECTFUL_PATTERNS: ReadonlyArray<{ action: EffectfulAction; pattern: RegExp }> = [
  { action: "git push", pattern: /\bgit(?:\s+-{1,2}[\w-]+(?:[= ]\S+)?)*\s+push\b/ },
  // Delivery line design §4.2: a merge request or pull request is outward-facing, like a push.
  { action: "glab mr create/update", pattern: /\bglab\s+mr\s+(?:create|new|update)\b/ },
  { action: "glab mr merge", pattern: /\bglab\s+mr\s+(?:merge|accept)\b/ },
  { action: "gh pr create/edit", pattern: /\bgh\s+pr\s+(?:create|edit)\b/ },
  { action: "gh pr merge", pattern: /\bgh\s+pr\s+merge\b/ },
  { action: "npm publish", pattern: /\bnpm(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+publish\b/ },
  { action: "pnpm publish", pattern: /\bpnpm(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+publish\b/ },
  { action: "yarn publish", pattern: /\byarn(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+(?:npm\s+)?publish\b/ },
  { action: "kubectl apply/delete", pattern: /\bkubectl\b[^\n;&|]*?\s(?:apply|delete)\b/ },
  { action: "terraform apply/destroy", pattern: /\bterraform\b[^\n;&|]*?\s(?:apply|destroy)\b/ },
  { action: "helm install/upgrade/uninstall", pattern: /\bhelm\b[^\n;&|]*?\s(?:install|upgrade|uninstall)\b/ },
  { action: "vercel --prod", pattern: /\bvercel\b[^\n;&|]*?\s--prod\b/ },
  { action: "docker push", pattern: /\bdocker\s+(?:image\s+)?push\b/ },
  { action: "DROP TABLE/DATABASE", pattern: /\bdrop\s+(?:table|database)\b/i },
  { action: "TRUNCATE", pattern: /\btruncate\s+(?:table\s+)?[\w"`[]/i },
];

/**
 * The declared effects (`decisions.ts`) a grant must hold to cover each action:
 * any one of them. A `docker push` ships an image, so a push, a publish or a
 * deploy grant covers it.
 */
export const ACTION_EFFECTS: Readonly<Record<EffectfulAction, readonly Effect[]>> = {
  "git push": ["push"],
  "glab mr create/update": ["push"],
  "glab mr merge": ["push"],
  "gh pr create/edit": ["push"],
  "gh pr merge": ["push"],
  "npm publish": ["publish"],
  "pnpm publish": ["publish"],
  "yarn publish": ["publish"],
  "kubectl apply/delete": ["deploy"],
  "terraform apply/destroy": ["deploy"],
  "helm install/upgrade/uninstall": ["deploy"],
  "vercel --prod": ["deploy"],
  "docker push": ["push", "publish", "deploy"],
  "DROP TABLE/DATABASE": ["real-data", "migration"],
  TRUNCATE: ["real-data", "migration"],
  "DELETE FROM without WHERE": ["real-data", "migration"],
  "rm -rf outside the workspace": ["outside-workspace"],
};

/**
 * The gate category whose words name each action (`decision-gate.ts`, English
 * and Vietnamese, negations honoured): the one whose effects
 * (`GATE_CATEGORY_EFFECTS`) hold one of the action's (`ACTION_EFFECTS`).
 * `null` for `rm -rf`, whose `outside-workspace` no category holds: `RM_NAMED`
 * names it.
 */
export const ACTION_CATEGORY: Readonly<Record<EffectfulAction, GateCategory | null>> = Object.fromEntries(
  EFFECTFUL_ACTIONS.map((action) => [
    action,
    GATE_CATEGORIES.find((category) => ACTION_EFFECTS[action].some((effect) => GATE_CATEGORY_EFFECTS[category].includes(effect))) ?? null,
  ]),
) as Record<EffectfulAction, GateCategory | null>;

const RM_NAMED = /\brm\s+-[a-z]*r|(?<![\p{L}\p{N}_])(?:delete|remove|xoá|xóa)(?![\p{L}\p{N}_])/iu;

/** True when an owner's text names the action: a word of its gate category (not negated), or `rm -rf` / delete / remove. */
export function namesAction(text: string, action: EffectfulAction): boolean {
  const category = ACTION_CATEGORY[action];
  if (category === null) return RM_NAMED.test(text.normalize("NFC"));
  return gateMatchesOf(text).some((match) => match.category === category && !match.negated);
}

/** `path` with `.` and `..` resolved against `base`, POSIX style. */
function resolvePosix(base: string, path: string): string {
  const parts: string[] = [];
  for (const part of `${path.startsWith("/") ? "" : `${base}/`}${path}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** True when `path` is `directory` or lies below it. */
function isInsidePosix(path: string, directory: string): boolean {
  const root = resolvePosix("/", directory);
  const target = resolvePosix("/", path);
  return target === root || target.startsWith(root === "/" ? root : `${root}/`);
}

// ---------------------------------------------------------------------------
// Write paths and the scratch area (autonomy design §D.2, change-009 C5): one
// judge for the action boundary's `outside-workspace`, A-6's `rm -rf outside
// the workspace` and the watch's `danger`.
// ---------------------------------------------------------------------------

/**
 * The system temp roots (§D.2): a write below one is in the scratch area.
 * `/var/folders/<a>/<b>/T` is macOS's per-user temp folder (`$TMPDIR`).
 */
export const SCRATCH_ROOTS: readonly string[] = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];
const MACOS_TEMP = /^(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/;

/** Where a write lands: in the workspace, in the scratch area, outside both, or not readable from the text. */
export type PathVerdict = "inside" | "scratch" | "outside" | "unjudged";

/** What a path is judged against. */
export interface PathContext {
  /** Where the command runs; a relative path resolves against it. Null when unknown (a `cd` to a variable). */
  cwd: string | null;
  /** The workspace folder; null when unknown (then nothing but the scratch area and `~` can be judged). */
  workspaceDirectory: string | null;
  /** More scratch roots: the daemon's `TMPDIR`. */
  scratchRoots?: readonly string[];
  /** The home folder `~` stands for; unknown by default (then `~` is outside). */
  homeDirectory?: string | null;
}

/** Variables a command assigned: `scratch` from `mktemp`, else the literal path, else unknown (null). */
export type KnownVariables = ReadonlyMap<string, string | "scratch" | null>;

const DEV_FILES = /^\/dev\/(?:null|stdout|stderr|tty|fd\/\d+)$/;

function isScratchPath(path: string, context: PathContext): boolean {
  if (MACOS_TEMP.test(path)) return true;
  return [...SCRATCH_ROOTS, ...(context.scratchRoots ?? [])].some((root) => root !== "" && isInsidePosix(path, root));
}

/**
 * Where one written path lands (§D.2): `/dev/null` and the like write
 * nothing (`inside`); the scratch area is the system temp roots and a
 * variable the same command assigned from `mktemp`; `~` and `$HOME` are the
 * home folder (outside unless the workspace is below it); a path that still
 * holds a variable or a substitution, or a relative one while `cwd` is
 * unknown, cannot be judged. Pure.
 */
export function pathVerdictOf(word: string, context: PathContext, variables: KnownVariables = new Map()): PathVerdict {
  let path = word;
  // A leading `$(pwd)`, or a leading variable: one the command assigned, `$TMPDIR`, `$HOME` or `$PWD`,
  // written `$NAME`, `${NAME}` or `${NAME:-default}`.
  const pwd = /^(?:\$\(pwd\)|`pwd`)(?=\/|$)/.exec(path);
  const leading = pwd === null ? /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-=][^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(path) : null;
  if (pwd !== null) {
    if (context.cwd === null) return "unjudged";
    path = `${context.cwd}${path.slice(pwd[0].length)}`;
  } else if (leading !== null) {
    const name = leading[1] ?? leading[2]!;
    const rest = path.slice(leading[0].length);
    const known = variables.get(name);
    const climbs = /(^|\/)\.\.(\/|$)/.test(rest);
    // macOS's `$TMPDIR` ends with `/`, so `${TMPDIR}name` is inside it too.
    if (known === undefined && name === "TMPDIR") return climbs ? "unjudged" : "scratch";
    if (rest !== "" && !rest.startsWith("/")) return "unjudged";
    if (known === "scratch") return climbs ? "unjudged" : "scratch";
    if (typeof known === "string") path = `${known}${rest}`;
    else if (known === undefined && name === "HOME") path = `~${rest}`;
    else if (known === undefined && name === "PWD" && context.cwd !== null) path = `${context.cwd}${rest}`;
    else return "unjudged";
  }
  if (path.includes("$") || path.includes("`")) return "unjudged";
  if (/^~(?:\/|$)/.test(path)) {
    if (context.homeDirectory == null) return "outside";
    path = `${context.homeDirectory}${path.slice(1)}`;
  }
  if (DEV_FILES.test(path)) return "inside";
  if (!path.startsWith("/")) {
    if (context.cwd === null) return "unjudged";
    path = resolvePosix(context.cwd, path);
  } else path = resolvePosix("/", path);
  if (context.workspaceDirectory !== null && isInsidePosix(path, context.workspaceDirectory)) return "inside";
  if (isScratchPath(path, context)) return "scratch";
  return context.workspaceDirectory === null ? "unjudged" : "outside";
}

/** The variables a line's commands assign, in order: `mktemp` makes one scratch, a literal path is kept, anything else is unknown. */
function assignedVariables(commands: readonly ShellCommand[]): Map<string, string | "scratch" | null> {
  const variables = new Map<string, string | "scratch" | null>();
  for (const command of commands) {
    for (const { name, value } of command.assignments) variables.set(name, variableValueOf(value));
  }
  return variables;
}

function variableValueOf(value: ShellWord): string | "scratch" | null {
  if (value.substitutions.length === 1 && /^\s*mktemp\b/.test(value.substitutions[0]!) && /^\$\(|^`/.test(value.value)) return "scratch";
  return value.dynamic ? null : value.value;
}

/** The program of a command's words, with its path and the wrappers (`sudo`, `env`, `time`, …) left out; its index in `words`. */
function programOf(words: readonly ShellWord[]): { name: string; index: number; dynamic: boolean } | null {
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    const name = word.value.split("/").pop() ?? word.value;
    if (word.dynamic) return { name, index, dynamic: true };
    if (name === "sudo" || name === "doas") {
      index += 1;
      while (index < words.length && words[index]!.value.startsWith("-")) index += /^-[ugCDhpr]$/.test(words[index]!.value) ? 2 : 1;
      continue;
    }
    if (name === "env") {
      index += 1;
      while (index < words.length && (words[index]!.value.startsWith("-") || ASSIGNMENT_WORD.test(words[index]!.value))) index += 1;
      continue;
    }
    if (name === "nice" || name === "nohup" || name === "time" || name === "command" || name === "exec" || name === "stdbuf" || name === "caffeinate") {
      index += 1;
      while (index < words.length && words[index]!.value.startsWith("-")) index += 1;
      continue;
    }
    if (name === "timeout") {
      index += 1;
      while (index < words.length && words[index]!.value.startsWith("-")) index += 1;
      index += 1; // the duration
      continue;
    }
    return { name, index, dynamic: false };
  }
  return null;
}

const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The `rm -rf` targets of a command line (recursive and forced), each with
 * where it lands (`pathVerdictOf`), a relative one resolved from `cwd` —
 * followed through the line's `cd` — else from the workspace folder.
 */
function rmTargetsOf(command: string, cwd: string | null, workspaceDirectory: string | null): Array<{ target: string; verdict: PathVerdict }> {
  const parsed = parseShellLine(command);
  const variables = assignedVariables(parsed.commands);
  const out: Array<{ target: string; verdict: PathVerdict }> = [];
  let here: string | null = cwd ?? workspaceDirectory;
  for (const entry of parsed.commands) {
    const program = programOf(entry.words);
    if (program === null || program.dynamic) continue;
    const args = entry.words.slice(program.index + 1);
    if (program.name === "cd") {
      here = cdTarget(args, here, variables);
      continue;
    }
    if (program.name !== "rm") continue;
    let recursive = false;
    let force = false;
    let flagsEnded = false;
    const targets: ShellWord[] = [];
    for (const word of args) {
      const value = word.value;
      if (!flagsEnded && value === "--") flagsEnded = true;
      else if (!flagsEnded && value.startsWith("--") && !word.dynamic) {
        if (value === "--recursive") recursive = true;
        if (value === "--force") force = true;
      } else if (!flagsEnded && value.startsWith("-") && value.length > 1 && !word.dynamic) {
        if (/[rR]/.test(value)) recursive = true;
        if (/f/.test(value)) force = true;
      } else targets.push(word);
    }
    if (!recursive || !force) continue;
    for (const target of targets) {
      const verdict = /^\/+\*?$/.test(target.value) ? "outside" : pathVerdictOf(target.value, { cwd: here, workspaceDirectory }, variables);
      out.push({ target: target.value, verdict });
    }
  }
  return out;
}

/** Where a `cd` leaves the line: its target judged like a path; null (unknown) for a variable, `-` or the home folder. */
function cdTarget(args: readonly ShellWord[], here: string | null, variables: KnownVariables): string | null {
  const target = args.find((word) => !word.value.startsWith("-") || word.value === "-");
  if (target === undefined || target.value === "-" || target.value === "~") return null;
  let value = target.value;
  const leading = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(?=\/|$)/.exec(value);
  if (leading !== null) {
    const known = variables.get(leading[1] ?? leading[2]!);
    if (typeof known !== "string" || known === "scratch") return known === "scratch" ? "/tmp" : null;
    value = `${known}${value.slice(leading[0].length)}`;
  }
  if (value.includes("$") || value.includes("`") || value.startsWith("~")) return null;
  if (value.startsWith("/")) return resolvePosix("/", value);
  return here === null ? null : resolvePosix(here, value);
}

/** `DELETE FROM` with no `WHERE` in the same statement. */
function deleteWithoutWhere(command: string): boolean {
  for (const match of command.matchAll(/\bdelete\s+from\b([^;]*)/gi)) {
    if (!/\bwhere\b/i.test(match[1] ?? "")) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The SQL a command runs, as the danger signal and A-6 read it (design
// §7.17.8 f): not the SQL it only writes. Default deny: a here-document body
// is text only when its head writes it to files (`cat > down.sql <<EOF`,
// `tee a b <<EOF`) or is an interpreter's stdin script naming no database
// driver (`python3 - <<EOF` writing migrations); every other body is SQL that
// runs. The action boundary reads none of this.
// ---------------------------------------------------------------------------

/** The SQL actions; read from `SqlTexts`, never from the raw command. */
const SQL_ACTIONS: ReadonlySet<EffectfulAction> = new Set(["DROP TABLE/DATABASE", "TRUNCATE"]);
/** Outside a database client, a bare `truncate` is SQL only as `TRUNCATE TABLE` or an upper-case `TRUNCATE <name>`: Tailwind's `truncate` class is not. */
const TRUNCATE_TABLE = /\btruncate\s+table\s+[\w"`[]/i;
const TRUNCATE_UPPER = /\bTRUNCATE\s+[\w"`[]/;
/**
 * A database driver or call in a script, case-insensitive and never inside
 * another word (`import psycopg`, `require("mysql2")`, `@prisma/client`,
 * `cur.execute(`, `create_engine(`, a `postgres://` URL); `pgUrl` is not one.
 */
const DATABASE_DRIVER =
  /(?<!\w)(?:psycopg\d?|pymysql|mysqlclient|mysqldb|mysql\d?|mysql-connector|asyncpg|aiomysql|aiosqlite|sqlite\d?|better-sqlite3|duckdb|cx_oracle|oracledb|pyodbc|pymssql|mssql|tedious|mariadb|pg|pg-promise|postgres|knex|prisma|sequelize|typeorm|sqlalchemy|drizzle|jdbc)(?!\w)|\.(?:execute|executescript|query)\(|\b(?:cursor|create_engine)\(|\b(?:postgres(?:ql)?|mysql|mariadb|sqlite|mssql|sqlserver|oracle|redshift|cockroachdb|clickhouse)(?:\+\w+)?:\/\//i;
/** Database clients beyond `DATABASE_CLIS`, for the SQL a command runs only; `prisma db execute` and `supabase db` are read as phrases. */
const SQL_CLIENT_WORDS: ReadonlySet<string> = new Set(["dbshell", "bq", "snowsql", "cqlsh", "redis-cli"]);
/** Interpreters whose stdin script may be text: python and node with no script or `-`; ruby and perl with `-`. */
const STDIN_INTERPRETER = /^(?:python[\d.]*|node|ruby|perl)$/;
/** Words that make a head's body shell commands: shells, remote and container wrappers, and command wrappers. */
const SHELL_WRAPPERS: ReadonlySet<string> = new Set(["ssh", "docker", "kubectl", "podman", "sh", "bash", "zsh", "dash", "sudo", "env", "nohup", "timeout", "xargs"]);
/** Interpreters whose stdin is a script, not shell commands, even behind a wrapper (`ssh db python3 -`). */
const SCRIPT_INTERPRETER = /^(?:python[\d.]*|node|nodejs|ruby|perl|php|deno|bun)$/;
/** A shell body is read as a command line this deep; deeper, the body counts as SQL that runs. */
const MAX_HERE_DOCUMENT_DEPTH = 4;
const SQL_WORD = /\b(?:drop|truncate|delete)\b/i;

/** The texts a command's SQL is read from: `outside` with the strict `truncate`, `database` (a client's command, a body it is fed) case-insensitive. */
interface SqlTexts {
  outside: string[];
  database: string[];
}

const baseNameOf = (word: ShellWord): string => word.value.split("/").pop() ?? word.value;

/** True when the command is a database client's: one of its words names one (`psql`, `docker exec db psql`, `bq query`, `manage.py dbshell`, `prisma db execute`). */
function isDatabaseClient(command: ShellCommand): boolean {
  const names = command.words.map((word) => (word.dynamic ? "" : baseNameOf(word)));
  return names.some(
    (name, index) =>
      DATABASE_CLIS.has(name) ||
      SQL_CLIENT_WORDS.has(name) ||
      (name === "prisma" && names[index + 1] === "db" && names[index + 2] === "execute") ||
      (name === "supabase" && names[index + 1] === "db"),
  );
}

/** True when the command runs its script from stdin with one of `STDIN_INTERPRETER` (no script file, no `-c` / `-e` / `-m`). */
function isStdinScript(command: ShellCommand): boolean {
  const program = programOf(command.words);
  if (program === null || program.dynamic || !STDIN_INTERPRETER.test(program.name)) return false;
  const args = command.words.slice(program.index + 1);
  if (args.some((word) => ["-c", "-e", "-E", "-m", "--eval", "-p", "--print"].includes(word.value))) return false;
  if (args.some((word) => word.value === "-")) return true;
  return (program.name.startsWith("python") || program.name === "node") && positional(args).length === 0;
}

/** True when the command only writes its stdin to files: `cat > f` / `cat >> f` (no input file), `tee [-a] f…`. */
function isFileSink(command: ShellCommand): boolean {
  const program = programOf(command.words);
  if (program === null || program.dynamic) return false;
  const args = positional(command.words.slice(program.index + 1));
  const toFiles = (targets: readonly ShellWord[]) => targets.length > 0 && targets.every((word) => !/^\/dev\/(?:stdout|fd\/1|tty)$/.test(word.value));
  if (program.name === "cat") return args.every((word) => word.value === "-") && toFiles(command.writes);
  return program.name === "tee" && toFiles(args);
}

/** True when a word of the commands, by its base name, passes `test`. */
const namesWord = (commands: readonly ShellCommand[], test: (name: string) => boolean): boolean =>
  commands.some((entry) => entry.words.some((word) => !word.dynamic && test(baseNameOf(word))));

/**
 * How a here-document's head treats its body (default deny): `text` when the
 * head line's here-document commands are all file sinks (`isFileSink`), with
 * no pipe and no other command a client, shell or interpreter; or when it is a
 * stdin script (`isStdinScript`) whose body names no `DATABASE_DRIVER`.
 * `commands` when a shell or wrapper (`SHELL_WRAPPERS`) would run it as a
 * command line, no client nor script interpreter on the head. Else `sql`.
 */
function bodyReadingOf(head: string, body: string): "text" | "commands" | "sql" {
  const commands = parseShellLine(head).commands;
  if (commands.length === 0 || commands.some(isDatabaseClient)) return "sql";
  const feeding = commands.filter((entry) => entry.text.includes("<<"));
  const others = commands.filter((entry) => !feeding.includes(entry));
  const piped = /(?<!\|)\|(?!\|)/.test(head.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ""));
  const consumes = namesWord(others, (name) => SHELL_WRAPPERS.has(name) || SCRIPT_INTERPRETER.test(name));
  if (feeding.length > 0 && feeding.every(isFileSink) && !piped && !consumes) return "text";
  if (feeding.length > 0 && feeding.every(isStdinScript) && !piped && !consumes) return DATABASE_DRIVER.test(body) ? "sql" : "text";
  if (namesWord(commands, (name) => SHELL_WRAPPERS.has(name)) && !namesWord(commands, (name) => SCRIPT_INTERPRETER.test(name))) return "commands";
  return "sql";
}

/**
 * Where a command's SQL is read (see `SqlTexts`): the command without its
 * here-document bodies; each database client's own command; each body as its
 * head reads it (`bodyReadingOf`): skipped as text, read as a command line of
 * its own (`shell.ts` `hereDocumentsOf`), or as SQL that runs. Past
 * `MAX_HERE_DOCUMENT_DEPTH`, the whole body is read as SQL that runs.
 */
function sqlTextsOf(command: string, depth = 0): SqlTexts {
  if (depth > MAX_HERE_DOCUMENT_DEPTH) return { outside: [], database: [command] };
  const texts: SqlTexts = { outside: [withoutHereDocuments(command)], database: [] };
  for (const entry of parseShellLine(command).commands) if (isDatabaseClient(entry)) texts.database.push(entry.text);
  for (const { head, body } of hereDocumentsOf(command)) {
    const reading = bodyReadingOf(head, body);
    if (reading === "sql") texts.database.push(body);
    else if (reading === "commands") {
      const inner = sqlTextsOf(body, depth + 1);
      texts.outside.push(...inner.outside);
      texts.database.push(...inner.database);
    }
  }
  return texts;
}

/** True when the SQL texts run the action's pattern; outside a database client, `TRUNCATE` is read strictly. */
function runsSql(texts: SqlTexts, action: EffectfulAction, pattern: RegExp): boolean {
  if (texts.database.some((text) => pattern.test(text))) return true;
  if (action === "TRUNCATE") return texts.outside.some((text) => TRUNCATE_TABLE.test(text) || TRUNCATE_UPPER.test(text));
  return texts.outside.some((text) => pattern.test(text));
}

/**
 * What a shell command runs of the list: the action, and the name its
 * evidence gives — the action's own, or `rm -rf <target>` — or none, with
 * whether an `rm -rf` target could not be judged and whether one deleted in
 * the scratch area (§D.2: not an effectful action; A-6 counts it apart).
 */
export type EffectfulCommand = { action: EffectfulAction; name: string } | { action: null; rmNotJudged: boolean; scratchRm: boolean };

/**
 * The effectful action a shell command runs (see `EffectfulCommand`). `cwd` is
 * where it ran: a relative `rm` target is resolved against it, else against
 * the workspace directory. Its SQL is the SQL it runs (`sqlTextsOf`). Pure.
 */
export function effectfulCommandOf(command: string, cwd: string | null, workspaceDirectory: string | null): EffectfulCommand {
  const sql: SqlTexts = SQL_WORD.test(command) ? sqlTextsOf(command) : { outside: [], database: [] };
  for (const { action, pattern } of EFFECTFUL_PATTERNS) {
    if (SQL_ACTIONS.has(action) ? runsSql(sql, action, pattern) : pattern.test(command)) return { action, name: action };
  }
  if ([...sql.outside, ...sql.database].some(deleteWithoutWhere)) return { action: "DELETE FROM without WHERE", name: "DELETE FROM without WHERE" };
  const targets = rmTargetsOf(command, cwd, workspaceDirectory);
  const outside = targets.find((entry) => entry.verdict === "outside");
  if (outside !== undefined) return { action: "rm -rf outside the workspace", name: `rm -rf ${outside.target}` };
  return {
    action: null,
    rmNotJudged: targets.some((entry) => entry.verdict === "unjudged"),
    scratchRm: targets.some((entry) => entry.verdict === "scratch"),
  };
}

/**
 * What a shell command of the evidence is for A-6: the effectful action it
 * runs, or none; `rmNotJudged` when an `rm -rf` target could not be judged,
 * `scratchRm` when one was in the scratch area. `cwd` is where it ran, when
 * the evidence kept it (autonomy design §C.1); a relative `rm` target is
 * resolved against it, else against the workspace directory.
 */
export function classifyCommand(
  command: string,
  workspaceDirectory: string | null,
  cwd: string | null = null,
): { action: EffectfulAction | null; rmNotJudged: boolean; scratchRm: boolean } {
  const found = effectfulCommandOf(command, cwd, workspaceDirectory);
  return found.action === null ? found : { action: found.action, rmNotJudged: false, scratchRm: false };
}

/** The effectful action a shell command runs, or null. */
export function effectfulActionOf(command: string, workspaceDirectory: string | null): EffectfulAction | null {
  return classifyCommand(command, workspaceDirectory).action;
}

// ---------------------------------------------------------------------------
// The action boundary's classes (autonomy design §D.2, change-009 C4–C5): what
// a permission request would do that only a grant, the policy or the owner
// may allow. Only the literal command is read; what a script does inside is
// seen by detection only (the watch, A-6) — except a package script, whose
// body is read from the `package.json` it runs from.
// ---------------------------------------------------------------------------

/** One held effect a request would have. */
export interface HeldFinding {
  /** What it does, in a few words the owner reads: `git push`, `curl`, `write /etc/hosts`. */
  what: string;
  /**
   * The effects that allow it: a grant holding any one of them covers it
   * (`ACTION_EFFECTS`); the first is the one the held decision's Allow declares.
   */
  effects: readonly Effect[];
  /** True when the request could not be read (§D.4): only the owner allows it (`security`). */
  unreadable: boolean;
  /**
   * A push of the mission branch to `origin`, or its merge request into the
   * integration branch (delivery line design §4.2): what the owner's standing
   * integration grant covers (§4.3). Absent otherwise.
   */
  integration?: true;
  /** A read of the forge (`glab mr view`, `glab ci status`, …): the grant covers it too. Absent otherwise. */
  forgeRead?: true;
}

/** What the boundary reads of one request: its held effects, and the writes that landed in the scratch area. */
export interface BoundaryVerdict {
  findings: HeldFinding[];
  scratchWrites: number;
}

/** What a command is judged against (see `PathContext`), and how a package script's body is read. */
export interface BoundaryContext extends PathContext {
  /**
   * The body of package script `name` as the runner would find it from `cwd`
   * (the nearest `package.json`): a string; null when there is no such script
   * (nothing of it runs); undefined when it cannot be read — then the script
   * is unreadable. Without it every package script is unreadable.
   */
  scriptBodyOf?: (name: string, cwd: string | null) => string | null | undefined;
  /**
   * The request's placement (delivery line design §4.2): its worktree, the
   * mission branch, the integration branch and the remote. Absent outside a
   * placement: git and the forge CLIs are read as before.
   */
  mission?: MissionBranch;
}

/** A placement as the boundary judges git and the forge CLIs against it (delivery line design §4.2). */
export interface MissionBranch {
  directory: string;
  branch: string;
  target: string;
  remote: "origin";
}

const RELEASE_PUSH: readonly Effect[] = ["push"];
const COMMIT: readonly Effect[] = ["commit"];
const RELEASE_PUBLISH: readonly Effect[] = ["publish"];
const RELEASE_DEPLOY: readonly Effect[] = ["deploy"];
const DOCKER_PUSH: readonly Effect[] = ["push", "publish", "deploy"];
const DATA_SQL: readonly Effect[] = ["real-data", "migration"];
const DATA_MIGRATION: readonly Effect[] = ["migration", "real-data"];
const DEPENDENCY: readonly Effect[] = ["dependency-install"];
const NETWORK: readonly Effect[] = ["network"];
const OUTSIDE: readonly Effect[] = ["outside-workspace"];
const SECURITY: readonly Effect[] = ["security"];

/** Package scripts are read this deep (a script running a script …); deeper is unreadable. */
export const MAX_SCRIPT_DEPTH = 4;

/** Database CLIs: given a write statement, or a statement from a file, they are `data`. */
const DATABASE_CLIS: ReadonlySet<string> = new Set(["sqlite3", "sqlite", "psql", "mysql", "mariadb", "mongosh", "mongo", "sqlcmd", "clickhouse-client", "duckdb", "cockroach"]);
const SQL_WRITE = /\b(?:insert|update|delete|alter|create|drop|truncate|replace|merge|grant|revoke|rename|upsert|db\.\w+\.(?:insert|update|delete|drop|remove)\w*)\b/i;

/** Network clients (§D.2); `scp` and `rsync` only with a remote side. */
const NETWORK_CLIS: ReadonlySet<string> = new Set(["curl", "wget", "ssh", "sftp", "nc", "ncat", "netcat", "telnet", "ftp", "http", "https", "xh"]);
const REMOTE_ARGUMENT = /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/)|^\w+:\/\//;

/** The words of a command after its program, with the flags that take a value (`-C dir`) skipped; `sub` is the first such word. */
function subcommandOf(args: readonly ShellWord[], valueFlags: ReadonlySet<string>): { sub: string | null; rest: ShellWord[] } {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!.value;
    if (value === "--") return { sub: args[index + 1]?.value ?? null, rest: args.slice(index + 2) };
    if (value.startsWith("-")) {
      if (valueFlags.has(value)) index += 1;
      continue;
    }
    return { sub: value, rest: args.slice(index + 1) };
  }
  return { sub: null, rest: [] };
}

const positional = (words: readonly ShellWord[]): ShellWord[] => words.filter((word) => !word.value.startsWith("-") || word.dynamic);

const GIT_VALUE_FLAGS: ReadonlySet<string> = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const PACKAGE_VALUE_FLAGS: ReadonlySet<string> = new Set(["--prefix", "-C", "--dir", "--cwd", "--filter", "-F", "-w", "--workspace", "--registry", "--userconfig"]);
const NPM_INSTALL: ReadonlySet<string> = new Set(["install", "i", "add", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall"]);
const NPM_UPDATE: ReadonlySet<string> = new Set(["update", "upgrade", "up", "udpate"]);
const NPM_RUN: ReadonlySet<string> = new Set(["run", "run-script", "rum", "urn"]);
const NPM_LIFECYCLE: ReadonlySet<string> = new Set(["test", "t", "tst", "start", "stop", "restart"]);
/** Commands of yarn / pnpm / bun that are not a package script's name. */
const RUNNER_BUILTINS: ReadonlySet<string> = new Set([
  "install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "outdated", "list", "ls", "ll", "la", "why", "info", "view",
  "init", "create", "link", "unlink", "pack", "publish", "config", "cache", "store", "audit", "licenses", "patch", "patch-commit", "rebuild",
  "import", "prune", "dedupe", "fetch", "env", "exec", "dlx", "x", "run", "test", "start", "stop", "restart", "workspace", "workspaces", "global",
  "node", "set", "version", "versions", "help", "bin", "root", "doctor", "setup", "self-update", "server", "team", "owner", "whoami", "login", "logout",
  "npm", "constraints", "plugin", "explain", "search", "tag", "dist-tag", "deploy", "ci", "build", "pm", "--version", "-v",
]);

/** Deploy CLIs beyond the A-6 list (§D.2 "the deploy CLIs"): the program, and the subcommands that ship. */
const DEPLOY_CLIS: Readonly<Record<string, (args: readonly ShellWord[]) => boolean>> = {
  kubectl: (args) => args.some((word) => ["apply", "delete"].includes(word.value)),
  terraform: (args) => args.some((word) => ["apply", "destroy"].includes(word.value)),
  helm: (args) => args.some((word) => ["install", "upgrade", "uninstall", "delete"].includes(word.value)),
  vercel: (args) => args.some((word) => word.value === "--prod" || word.value === "--production"),
  netlify: (args) => args.some((word) => word.value === "--prod") && args.some((word) => word.value === "deploy"),
  fly: (args) => args[0]?.value === "deploy",
  flyctl: (args) => args[0]?.value === "deploy",
  firebase: (args) => args[0]?.value === "deploy",
  wrangler: (args) => ["deploy", "publish"].includes(args[0]?.value ?? ""),
  serverless: (args) => args[0]?.value === "deploy",
  sls: (args) => args[0]?.value === "deploy",
  cdk: (args) => ["deploy", "destroy"].includes(args[0]?.value ?? ""),
  pulumi: (args) => ["up", "destroy"].includes(args[0]?.value ?? ""),
};

/** Migration runners (§D.2 data): the program (npx-style wrappers left out) and the words that migrate. */
function isMigration(name: string, args: readonly ShellWord[]): boolean {
  const words = args.map((word) => word.value);
  const has = (...wanted: string[]) => wanted.some((entry) => words.includes(entry));
  switch (name) {
    case "prisma":
      return (words[0] === "migrate" && has("deploy", "dev", "reset", "resolve")) || (words[0] === "db" && has("push", "execute", "seed"));
    case "knex":
    case "sequelize":
    case "typeorm":
      return words.some((word) => /^(?:migrate|migration|db):/.test(word) || word === "migration:run" || word === "schema:sync");
    case "rails":
    case "rake":
    case "bin/rails":
      return words.some((word) => /^db:(?:migrate|drop|reset|seed|rollback|setup|schema:load)/.test(word));
    case "alembic":
      return has("upgrade", "downgrade", "stamp");
    case "flyway":
      return has("migrate", "clean", "repair", "baseline", "undo");
    case "liquibase":
      return words.some((word) => /^(?:update|rollback|drop-all|dropAll)/.test(word));
    case "drizzle-kit":
      return has("push", "migrate", "drop");
    case "diesel":
    case "sqlx":
      return words[0] === "migration" || (words[0] === "migrate" && has("run", "revert")) || (words[0] === "database" && has("reset", "setup", "drop"));
    case "goose":
    case "dbmate":
    case "migrate":
      return has("up", "down", "up-by-one", "redo", "reset", "drop", "migrate", "rollback", "force");
    case "supabase":
      return words[0] === "db" && has("push", "reset");
    default:
      return false;
  }
}

/** The dependency-install commands of §D.2 (a bare lockfile install is not one). */
function isDependencyInstall(name: string, args: readonly ShellWord[]): boolean {
  const { sub, rest } = subcommandOf(args, PACKAGE_VALUE_FLAGS);
  const packages = positional(rest);
  switch (name) {
    case "npm":
      return (sub !== null && NPM_INSTALL.has(sub) && packages.length > 0) || (sub !== null && NPM_UPDATE.has(sub));
    case "pnpm":
    case "yarn":
    case "bun":
      if (sub === "global" && ["add", "install"].includes(packages[0]?.value ?? "")) return true;
      return (sub !== null && ["add", "install", "i"].includes(sub) && packages.length > 0) || sub === "upgrade" || sub === "up" || (sub === "update" && name !== "bun");
    case "pip":
    case "pip3":
    case "pipx":
      return sub === "install" && pipPackages(rest).length > 0;
    case "uv":
      return sub === "add" || (sub === "pip" && rest[0]?.value === "install" && pipPackages(rest.slice(1)).length > 0) || (sub === "tool" && rest[0]?.value === "install");
    case "poetry":
      return sub === "add";
    case "brew":
      return sub === "install" || sub === "reinstall" || sub === "upgrade";
    case "cargo":
      return sub === "add" || sub === "install";
    case "go":
      return sub === "get" || (sub === "install" && packages.length > 0);
    case "gem":
      return sub === "install";
    case "bundle":
      return sub === "add";
    case "composer":
      return sub === "require";
    case "apt":
    case "apt-get":
    case "dnf":
    case "yum":
      return sub === "install";
    default:
      return false;
  }
}

/** The packages a `pip install` names: not `-r file`, `-e path`, `-c file` or a local path. */
function pipPackages(args: readonly ShellWord[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!.value;
    if (["-r", "--requirement", "-e", "--editable", "-c", "--constraint", "-t", "--target", "--index-url", "-i", "--extra-index-url"].includes(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-") || value === "." || value.startsWith("./") || value.startsWith("/")) continue;
    out.push(value);
  }
  return out;
}

/** The paths a write command writes (§D.2: `rm`, `mv`, `cp`, `tee`, `mkdir`, `touch`, `ln`; `rmdir`, `dd of=`, `sed -i`, `find … -delete`). */
function writtenPathsOf(name: string, args: readonly ShellWord[]): ShellWord[] | null {
  const operands = (words: readonly ShellWord[]) => {
    const out: ShellWord[] = [];
    let ended = false;
    for (const word of words) {
      if (!ended && word.value === "--") ended = true;
      else if (!ended && word.value.startsWith("-") && word.value.length > 1 && !word.dynamic) continue;
      else out.push(word);
    }
    return out;
  };
  switch (name) {
    case "rm":
    case "rmdir":
    case "mkdir":
    case "touch":
    case "tee":
    case "shred":
    case "unlink":
      return operands(args);
    case "mv":
      // Both ends change: the sources go, the destination is written.
      return operands(args);
    case "cp":
    case "ln":
    case "install": {
      const target = args.findIndex((word) => word.value === "-t" || word.value === "--target-directory");
      if (target >= 0 && args[target + 1] !== undefined) return [args[target + 1]!];
      const found = operands(args);
      if (found.length === 0) return [];
      // `ln -s target` alone links in the current folder.
      return name === "ln" && found.length === 1 ? [{ value: ".", dynamic: false, substitutions: [] }] : [found[found.length - 1]!];
    }
    case "dd":
      return args.filter((word) => word.value.startsWith("of=")).map((word) => ({ ...word, value: word.value.slice(3) }));
    case "sed":
    case "perl": {
      const inPlace = args.some((word) => /^-[a-zA-Z]*i/.test(word.value) || word.value.startsWith("--in-place"));
      if (!inPlace) return null;
      const scripted = args.some((word) => word.value === "-e" || word.value === "-f" || word.value === "--expression");
      const files: ShellWord[] = [];
      let scriptSeen = scripted;
      for (let index = 0; index < args.length; index += 1) {
        const word = args[index]!;
        if (word.value === "-e" || word.value === "-f" || word.value === "--expression") {
          index += 1;
          continue;
        }
        // macOS `sed -i '' …`: the empty suffix.
        if (/^-[a-zA-Z]*i$/.test(word.value) && args[index + 1]?.value === "") {
          index += 1;
          continue;
        }
        if (word.value.startsWith("-") && !word.dynamic) continue;
        if (!scriptSeen) scriptSeen = true;
        else files.push(word);
      }
      return files;
    }
    case "find": {
      const deletes = args.some((word) => word.value === "-delete") || args.some((word, index) => word.value === "-exec" && ["rm", "/bin/rm"].includes(args[index + 1]?.value ?? ""));
      if (!deletes) return null;
      const starts: ShellWord[] = [];
      for (const word of args) {
        if (word.value.startsWith("-") || word.value === "(" || word.value === "!") break;
        starts.push(word);
      }
      return starts.length === 0 ? [{ value: ".", dynamic: false, substitutions: [] }] : starts;
    }
    default:
      return null;
  }
}

interface ClassifyState {
  context: BoundaryContext;
  findings: HeldFinding[];
  scratchWrites: number;
}

function addFinding(state: ClassifyState, finding: HeldFinding): void {
  if (!state.findings.some((known) => known.what === finding.what && known.unreadable === finding.unreadable)) state.findings.push(finding);
}

function unreadable(state: ClassifyState, what: string): void {
  addFinding(state, { what, effects: SECURITY, unreadable: true });
}

function judgeWrite(state: ClassifyState, word: ShellWord, cwd: string | null, variables: KnownVariables, verb: string): void {
  const verdict = pathVerdictOf(word.value, { ...state.context, cwd }, variables);
  if (verdict === "scratch") state.scratchWrites += 1;
  else if (verdict === "outside") addFinding(state, { what: `${verb} ${word.value}`, effects: OUTSIDE, unreadable: false });
  else if (verdict === "unjudged") unreadable(state, `${verb} ${word.value} (a path the command does not spell out)`);
}

// ---------------------------------------------------------------------------
// Git and the forge CLIs in a placement (delivery line design §4.2): a push of
// the mission branch and its merge request are `integration`, what the
// owner's one grant covers; a forge read is `forgeRead`; anything whose
// destination the text does not spell out stays held, never covered.
// ---------------------------------------------------------------------------

/** What a line's earlier git commands did: switched off the mission branch, changed a remote. */
interface GitLine {
  offBranch: boolean;
  remoteChanged: boolean;
}

/** The git subcommands that write the mission branch: none in the placement on it (§4.1). */
const GIT_WRITES: ReadonlySet<string> = new Set(["commit", "merge", "cherry-pick", "revert"]);
/** The `git push` flags that leave its destination as written; any other flag is no mission push. */
const PUSH_FLAGS: ReadonlySet<string> = new Set(["-u", "--set-upstream", "-q", "--quiet", "-v", "--verbose", "--progress", "--no-progress", "--porcelain", "-n", "--dry-run"]);

/**
 * A git call as it runs: its folder after each `-C` (null when the text does
 * not spell it out), whether a flag or a variable rewires it (`-c`,
 * `--git-dir`, `GIT_*=`), its subcommand (null when none or a variable) and
 * the words after it.
 */
function gitCallOf(command: ShellCommand, args: readonly ShellWord[], here: string | null): { dir: string | null; rewired: boolean; sub: string | null; rest: ShellWord[] } {
  let dir = here;
  let rewired = command.assignments.some((assignment) => assignment.name.startsWith("GIT_"));
  let index = 0;
  while (index < args.length) {
    const word = args[index]!;
    if (word.dynamic || !word.value.startsWith("-")) break;
    if (word.value === "-C") {
      const target = args[index + 1];
      dir = target === undefined || target.dynamic || target.value.startsWith("~") ? null : target.value.startsWith("/") ? resolvePosix("/", target.value) : dir === null ? null : resolvePosix(dir, target.value);
      index += 2;
      continue;
    }
    if (GIT_VALUE_FLAGS.has(word.value)) {
      rewired = true;
      index += 2;
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace|exec-path)=|^-c./.test(word.value)) rewired = true;
    index += 1;
  }
  const sub = args[index];
  return { dir, rewired, sub: sub === undefined || sub.dynamic ? null : sub.value, rest: args.slice(index + 1) };
}

/** A refspec that names the mission branch on both sides (`HEAD` for the source); never a forced or deleting one. */
function isMissionRef(ref: string, branch: string): boolean {
  const local = (name: string): string => name.replace(/^refs\/heads\//, "");
  const [source, destination, ...more] = ref.split(":");
  if (ref.startsWith("+") || more.length > 0 || source === undefined) return false;
  const fromBranch = source === "HEAD" || local(source) === branch;
  return destination === undefined ? fromBranch : fromBranch && local(destination) === branch;
}

/** `git push <remote> [refspec…]` to the mission's remote, every refspec the mission branch, only flags of `PUSH_FLAGS`. */
function isMissionPush(rest: readonly ShellWord[], mission: MissionBranch): boolean {
  const named: string[] = [];
  for (const word of rest) {
    if (word.dynamic) return false;
    if (word.value.startsWith("-")) {
      if (!PUSH_FLAGS.has(word.value)) return false;
      continue;
    }
    named.push(word.value);
  }
  return named[0] === mission.remote && named.slice(1).every((ref) => isMissionRef(ref, mission.branch));
}

/** True when a `git remote` or `git config` call changes where a remote points (the repository's config, shared with its root checkout). */
function changesRemote(sub: string, rest: readonly ShellWord[]): boolean {
  const words = rest.map((word) => word.value);
  if (sub === "remote") return ["add", "set-url", "rename", "remove", "rm"].includes(positional(rest)[0]?.value ?? "");
  if (sub !== "config" || words.some((word) => /^(?:--get|--list$|-l$)/.test(word))) return false;
  return rest.some((word) => word.dynamic || /^(?:remote|url|push)\./i.test(word.value));
}

/** Whether a branch-moving git call leaves the mission branch: `yes`, `back` onto it, or `no` (files only, or nothing moves). */
function leavesMissionBranch(sub: string, rest: readonly ShellWord[], mission: MissionBranch): "yes" | "back" | "no" {
  const moving = ["switch", "checkout", "rebase", "reset", "branch"];
  if (!moving.includes(sub)) return "no";
  // What the text does not spell out stays held (§4.2).
  if (rest.some((word) => word.dynamic)) return "yes";
  const has = (...flags: string[]) => rest.some((word) => flags.includes(word.value) || flags.some((flag) => flag.startsWith("--") && word.value.startsWith(`${flag}=`)));
  const named = positional(rest).map((word) => word.value);
  switch (sub) {
    case "switch":
      if (has("-c", "-C", "--create", "--force-create", "--orphan", "--detach", "-d")) return "yes";
      return named[0] === undefined ? "no" : named[0] === mission.branch ? "back" : "yes";
    case "checkout": {
      if (has("-b", "-B", "--orphan", "--detach")) return "yes";
      // `git checkout -- <paths>`, or a tree-ish and paths: files only.
      if (has("--") || named.length !== 1) return "no";
      const target = named[0]!;
      if (target === mission.branch) return "back";
      const pathLike = target === "HEAD" || target === "." || target.startsWith("./") || target.startsWith("../") || target.includes("*") || /\.[A-Za-z0-9]+$/.test(target);
      return pathLike ? "no" : "yes";
    }
    case "rebase":
      return has("--abort") ? "no" : "yes";
    case "reset":
      return has("--hard") ? "yes" : "no";
    default:
      return has("--delete", "--move", "--force") || rest.some((word) => /^-[a-zA-Z]*[dDmMf]/.test(word.value)) ? "yes" : "no";
  }
}

/** A git call of a Worker in a placement (§4.2's rows), into `state`; `gitLine` carries what earlier calls of the line did. */
function gitInMission(state: ClassifyState, command: ShellCommand, args: readonly ShellWord[], here: string | null, mission: MissionBranch, gitLine: GitLine): void {
  const call = gitCallOf(command, args, here);
  if (call.sub === null) {
    if (args.some((word) => word.dynamic)) unreadable(state, "git with a subcommand the command does not spell out");
    return;
  }
  const { sub, rest } = call;
  const inside = call.dir !== null && isInsidePosix(call.dir, mission.directory);
  if (sub === "push") {
    const covered = inside && !call.rewired && !gitLine.remoteChanged && !gitLine.offBranch && isMissionPush(rest, mission);
    addFinding(state, covered ? { what: `git push ${mission.branch}`, effects: RELEASE_PUSH, unreadable: false, integration: true } : { what: "git push", effects: RELEASE_PUSH, unreadable: false });
    return;
  }
  if (sub === "remote" || sub === "config") {
    if (!changesRemote(sub, rest)) return;
    gitLine.remoteChanged = true;
    addFinding(state, { what: `git ${sub} ${positional(rest)[0]?.value ?? ""} (the repository's config, shared with its root checkout)`.replace("  ", " "), effects: OUTSIDE, unreadable: false });
    return;
  }
  const leaves = leavesMissionBranch(sub, rest, mission);
  if (!GIT_WRITES.has(sub) && leaves === "no") return;
  if (call.dir === null) {
    unreadable(state, `git ${sub} in a folder the command does not spell out`);
    return;
  }
  if (!inside) {
    addFinding(state, { what: `git ${sub} outside the mission's worktree`, effects: OUTSIDE, unreadable: false });
    return;
  }
  if (leaves === "back") {
    gitLine.offBranch = false;
    return;
  }
  if (leaves === "yes" && (sub === "switch" || sub === "checkout")) gitLine.offBranch = true;
  if (leaves === "yes" || gitLine.offBranch) addFinding(state, { what: `git ${sub} off the mission branch`, effects: COMMIT, unreadable: false });
}

/** The flags of `glab mr create/update` and `gh pr create/edit` that the boundary reads (§4.2); any other flag is no covered request. */
const FORGE_FLAGS: Readonly<Record<"glab" | "gh", { value: ReadonlySet<string>; bool: ReadonlySet<string>; source: readonly string[]; target: readonly string[]; away: readonly string[] }>> = {
  glab: {
    value: new Set(["-t", "--title", "-d", "--description", "-l", "--label", "-u", "--unlabel", "-a", "--assignee", "--reviewer", "-m", "--milestone", "-i", "--related-issue"]),
    bool: new Set(["-f", "--fill", "--fill-commit-body", "--draft", "--wip", "-r", "--ready", "--push", "-y", "--yes", "--no-editor", "-w", "--web", "--remove-source-branch", "--squash-before-merge", "--allow-collaboration", "--lock-discussion", "--unlock-discussion"]),
    source: ["-s", "--source-branch"],
    target: ["-b", "--target-branch"],
    away: ["-R", "--repo", "-H", "--head"],
  },
  gh: {
    value: new Set(["-t", "--title", "-b", "--body", "-F", "--body-file", "-T", "--template", "-l", "--label", "-a", "--assignee", "-r", "--reviewer", "-m", "--milestone", "-p", "--project", "--add-label", "--remove-label", "--add-assignee", "--remove-assignee", "--add-reviewer", "--remove-reviewer", "--add-project", "--remove-project"]),
    bool: new Set(["-d", "--draft", "-f", "--fill", "--fill-first", "--fill-verbose", "--no-maintainer-edit", "--dry-run", "-w", "--web"]),
    source: ["-H", "--head"],
    target: ["-B", "--base"],
    away: ["-R", "--repo"],
  },
};

/**
 * True for `glab mr create/update` or `gh pr create/edit` of the mission
 * branch into the integration branch (§4.2): the source the mission branch or
 * left out, the target the integration branch (named when creating), no
 * other repository, every flag known. Pure.
 */
function forgeRequestCovered(cli: "glab" | "gh", verb: string, rest: readonly ShellWord[], mission: MissionBranch): boolean {
  const flags = FORGE_FLAGS[cli];
  let source: string | undefined;
  let target: string | undefined;
  const named: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index]!;
    if (word.dynamic) return false;
    if (!word.value.startsWith("-") || word.value === "-") {
      named.push(word.value);
      continue;
    }
    const equals = word.value.startsWith("--") ? word.value.indexOf("=") : -1;
    const flag = equals < 0 ? word.value : word.value.slice(0, equals);
    const takesValue = flags.value.has(flag) || [...flags.source, ...flags.target, ...flags.away].includes(flag);
    if (!takesValue) {
      if (flags.bool.has(flag) && equals < 0) continue;
      return false;
    }
    let value = equals < 0 ? undefined : word.value.slice(equals + 1);
    if (value === undefined) {
      const next = rest[index + 1];
      if (next === undefined || next.dynamic) return false;
      value = next.value;
      index += 1;
    }
    if (flags.away.includes(flag)) return false;
    if (flags.source.includes(flag)) source = value;
    if (flags.target.includes(flag)) target = value;
  }
  if (source !== undefined && source !== mission.branch) return false;
  const creating = verb === "create" || verb === "new";
  if (creating ? target !== mission.target : target !== undefined && target !== mission.target) return false;
  return named.length === 0 || (!creating && named.length === 1 && named[0] === mission.branch);
}

const FORGE_READ: HeldFinding = { what: "glab (read)", effects: NETWORK, unreadable: false, forgeRead: true };

/** A `glab` call (§4.2): a merge request of the mission branch is `integration`; reads are `forgeRead`; merging is `push`; anything else is `network`, never covered. */
function glabFinding(state: ClassifyState, args: readonly ShellWord[], mission: MissionBranch | undefined): void {
  const [group, verb] = args;
  if (group === undefined || group.dynamic || verb?.dynamic === true) {
    addFinding(state, { what: "glab", effects: NETWORK, unreadable: false });
    return;
  }
  const action = verb?.value;
  if (group.value === "mr") {
    if (action === "create" || action === "new" || action === "update") {
      const covered = mission !== undefined && forgeRequestCovered("glab", action, args.slice(2), mission);
      addFinding(state, { what: `glab mr ${action}`, effects: RELEASE_PUSH, unreadable: false, ...(covered ? { integration: true as const } : {}) });
    } else if (action === "merge" || action === "accept") addFinding(state, { what: "glab mr merge", effects: RELEASE_PUSH, unreadable: false });
    else if (["view", "show", "list", "ls", "diff"].includes(action ?? "")) addFinding(state, FORGE_READ);
    else addFinding(state, { what: `glab mr ${action ?? ""}`.trim(), effects: NETWORK, unreadable: false });
    return;
  }
  if (group.value === "ci" || group.value === "pipeline" || group.value === "pipe") {
    if (["status", "view", "list", "ls", "get", "trace"].includes(action ?? "")) addFinding(state, FORGE_READ);
    else addFinding(state, { what: `glab ci ${action ?? ""}`.trim(), effects: NETWORK, unreadable: false });
    return;
  }
  addFinding(state, { what: `glab ${group.value}`, effects: NETWORK, unreadable: false });
}

/**
 * The body of a package script, classified as a command of its own from the
 * same folder, with its `pre` and `post` scripts. No such script runs nothing.
 */
function classifyScript(state: ClassifyState, runner: string, name: string, cwd: string | null, depth: number): void {
  if (depth >= MAX_SCRIPT_DEPTH) {
    unreadable(state, `${runner} run ${name} (package scripts nested too deep to read)`);
    return;
  }
  const bodyOf = state.context.scriptBodyOf;
  const body = bodyOf === undefined ? undefined : bodyOf(name, cwd);
  if (body === undefined) {
    unreadable(state, `${runner} run ${name} (its package script could not be read)`);
    return;
  }
  if (body === null) return;
  for (const part of [bodyOf!(`pre${name}`, cwd), body, bodyOf!(`post${name}`, cwd)]) {
    if (typeof part === "string") classifyLine(part, state, cwd, depth + 1);
  }
}

/** Classifies one command line, run from `cwd`, into `state`; `depth` counts the package scripts it runs inside. */
function classifyLine(line: string, state: ClassifyState, cwd: string | null, depth: number): void {
  const into = state;
  const parsed = parseShellLine(line);
  const gitLine: GitLine = { offBranch: false, remoteChanged: false };
  if (parsed.unbalanced) unreadable(into, "a command whose quotes or substitutions do not close");
  const variables = assignedVariables(parsed.commands);
  let here = cwd;
  for (const command of parsed.commands) {
    for (const target of command.writes) judgeWrite(into, target, here, variables, "write");
    const program = programOf(command.words);
    if (program === null) continue;
    if (program.dynamic) {
      // `$S/check.sh` runs a script, like `./check.sh`: only detection sees inside it (§D.2's limit). A bare
      // `$CMD` or `$(…)` could be any command.
      const value = command.words[program.index]!.value;
      if (!/^(?:\$[A-Za-z_]\w*|\$\{[^}]*\})\/[^$`]*$/.test(value)) unreadable(into, `${value} (a command held in a variable)`);
      continue;
    }
    let { name } = program;
    let args = command.words.slice(program.index + 1);
    // `npx prisma …`, `pnpm exec …`, `xargs rm …`: the program they run.
    for (let hops = 0; hops < 3; hops += 1) {
      if (["npx", "bunx", "pnpx"].includes(name) || ((name === "pnpm" || name === "yarn" || name === "npm" || name === "bun") && ["exec", "dlx", "x"].includes(args[0]?.value ?? ""))) {
        const rest = ["npx", "bunx", "pnpx"].includes(name) ? args : args.slice(1);
        const index = rest.findIndex((word) => !word.value.startsWith("-"));
        if (index < 0) break;
        name = rest[index]!.value.split("/").pop() ?? rest[index]!.value;
        args = rest.slice(index + 1);
        continue;
      }
      if (name === "xargs") {
        const index = args.findIndex((word) => !word.value.startsWith("-"));
        if (index < 0) break;
        name = args[index]!.value.split("/").pop() ?? args[index]!.value;
        args = args.slice(index + 1);
        // What xargs adds comes from its input: a write command's targets cannot be read.
        if (writtenPathsOf(name, args) !== null) unreadable(into, `xargs ${name} (its targets come from its input)`);
        continue;
      }
      break;
    }
    if (name === "cd" || name === "pushd") {
      here = cdTarget(args, here, variables);
      continue;
    }
    if (["sh", "bash", "zsh", "dash", "ksh"].includes(name)) {
      const flag = args.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word.value));
      const body = flag >= 0 ? args[flag + 1] : undefined;
      if (body !== undefined) {
        if (body.dynamic && body.substitutions.length === 0 && /\$/.test(body.value)) unreadable(into, `${name} -c ${body.value} (a command held in a variable)`);
        else classifyLine(body.value, state, here, depth);
      }
      continue;
    }
    if (name === "eval") {
      classifyLine(args.map((word) => word.value).join(" "), state, here, depth);
      continue;
    }

    // release
    if (name === "git") {
      const mission = state.context.mission;
      if (mission === undefined) {
        const { sub } = subcommandOf(args, GIT_VALUE_FLAGS);
        if (sub === "push") addFinding(into, { what: "git push", effects: RELEASE_PUSH, unreadable: false });
      } else gitInMission(into, command, args, here, mission, gitLine);
      continue;
    }
    if (name === "glab") {
      glabFinding(into, args, state.context.mission);
      continue;
    }
    if (name === "docker" || name === "podman") {
      const words = args.map((word) => word.value);
      if (words[0] === "push" || (words[0] === "image" && words[1] === "push")) addFinding(into, { what: `${name} push`, effects: DOCKER_PUSH, unreadable: false });
      continue;
    }
    if (name === "gh") {
      const words = args.map((word) => word.value);
      if (words[0] === "release" && ["create", "upload", "edit"].includes(words[1] ?? "")) addFinding(into, { what: `gh release ${words[1]}`, effects: RELEASE_PUBLISH, unreadable: false });
      else if (words[0] === "pr" && ["create", "edit"].includes(words[1] ?? "")) {
        const covered = state.context.mission !== undefined && forgeRequestCovered("gh", words[1]!, args.slice(2), state.context.mission);
        addFinding(into, { what: `gh pr ${words[1]}`, effects: RELEASE_PUSH, unreadable: false, ...(covered ? { integration: true as const } : {}) });
      } else if (words[0] === "pr" && words[1] === "merge") addFinding(into, { what: "gh pr merge", effects: RELEASE_PUSH, unreadable: false });
      else addFinding(into, { what: "gh (GitHub over the network)", effects: NETWORK, unreadable: false });
      continue;
    }
    const deploy = DEPLOY_CLIS[name];
    if (deploy !== undefined) {
      if (deploy(args)) addFinding(into, { what: `${name} ${args.map((word) => word.value).filter((word) => !word.startsWith("-")).slice(0, 2).join(" ")}`.trim(), effects: RELEASE_DEPLOY, unreadable: false });
      continue;
    }
    if (["npm", "pnpm", "yarn", "bun"].includes(name)) {
      const { sub, rest } = subcommandOf(args, PACKAGE_VALUE_FLAGS);
      if (sub === "publish" || (name === "yarn" && sub === "npm" && rest[0]?.value === "publish")) {
        addFinding(into, { what: `${name} publish`, effects: RELEASE_PUBLISH, unreadable: false });
        continue;
      }
      if (isDependencyInstall(name, args)) {
        addFinding(into, { what: `${name} ${sub ?? "install"} ${positional(rest).map((word) => word.value).join(" ")}`.trim(), effects: DEPENDENCY, unreadable: false });
        continue;
      }
      if (sub === null) continue;
      if (NPM_RUN.has(sub) || (name !== "npm" && sub === "run")) {
        const script = rest.find((word) => !word.value.startsWith("-"));
        if (script === undefined) continue;
        if (script.dynamic) unreadable(into, `${name} run ${script.value} (a script named by a variable)`);
        else classifyScript(state, name, script.value, here, depth);
        continue;
      }
      if (NPM_LIFECYCLE.has(sub)) {
        classifyScript(state, name, sub === "t" || sub === "tst" ? "test" : sub, here, depth);
        continue;
      }
      // `yarn build`, `pnpm lint`: a script by its name, or a command of the runner.
      if (name !== "npm" && !RUNNER_BUILTINS.has(sub)) classifyScript(state, name, sub, here, depth);
      continue;
    }

    // data
    if (DATABASE_CLIS.has(name)) {
      const fromFile = args.some((word) => ["-f", "--file", "-i", "--init"].includes(word.value)) || /(?:^|\s)\.read\s/.test(command.text);
      if (fromFile || SQL_WRITE.test(command.text)) addFinding(into, { what: `${name} with a write statement`, effects: DATA_SQL, unreadable: false });
      continue;
    }
    if (isMigration(name, args) || (name === "python" || name === "python3" ? args[0]?.value.endsWith("manage.py") && ["migrate", "flush"].includes(args[1]?.value ?? "") : false)) {
      addFinding(into, { what: `${name} ${args.slice(0, 2).map((word) => word.value).join(" ")} (a migration)`.trim(), effects: DATA_MIGRATION, unreadable: false });
      continue;
    }

    // dependency-install
    if (isDependencyInstall(name, args) || ((name === "python" || name === "python3") && args[0]?.value === "-m" && args[1]?.value === "pip" && isDependencyInstall("pip", args.slice(2)))) {
      addFinding(into, { what: `${name} ${args.map((word) => word.value).slice(0, 3).join(" ")}`.trim(), effects: DEPENDENCY, unreadable: false });
      continue;
    }

    // network
    if (NETWORK_CLIS.has(name)) {
      addFinding(into, { what: name, effects: NETWORK, unreadable: false });
      continue;
    }
    if (name === "scp" || name === "rsync") {
      const operands = positional(args);
      if (operands.some((word) => REMOTE_ARGUMENT.test(word.value))) {
        addFinding(into, { what: `${name} to a remote host`, effects: NETWORK, unreadable: false });
        continue;
      }
      // A local copy: its destination is a write.
      const destination = operands[operands.length - 1];
      if (destination !== undefined && operands.length > 1) judgeWrite(into, destination, here, variables, name);
      continue;
    }

    // outside-workspace
    const written = writtenPathsOf(name, args);
    if (written !== null) for (const word of written) judgeWrite(into, word, here, variables, name);
  }
  // The SQL the A-6 list names, wherever it appears (a heredoc to a client, a script's argument).
  if (EFFECTFUL_PATTERNS.some(({ action, pattern }) => (action === "DROP TABLE/DATABASE" || action === "TRUNCATE") && pattern.test(line)) || deleteWithoutWhere(line)) {
    if (!into.findings.some((finding) => finding.effects === DATA_SQL)) addFinding(into, { what: "a destructive SQL statement", effects: DATA_SQL, unreadable: false });
  }
}

/**
 * The held effects of a shell command a permission request carries (§D.2),
 * run from `context.cwd`: those of each command of the line, of its `sh -c`
 * and `eval` bodies, its substitutions and the package scripts it runs; the
 * destructive SQL of the A-6 list wherever it appears. Pure.
 */
export function boundaryVerdictOfCommand(command: string, context: BoundaryContext): BoundaryVerdict {
  const state: ClassifyState = { context, findings: [], scratchWrites: 0 };
  if (command.trim() === "") unreadable(state, "an empty command");
  else classifyLine(command, state, context.cwd, 0);
  return { findings: state.findings, scratchWrites: state.scratchWrites };
}

/** The held effects of a file tool writing `path` (Claude `Edit` / `Write` / `NotebookEdit`, a Codex file change). Pure. */
export function boundaryVerdictOfWrite(path: string, context: BoundaryContext): BoundaryVerdict {
  const state: ClassifyState = { context, findings: [], scratchWrites: 0 };
  if (path.trim() === "") unreadable(state, "a file change without its path");
  else judgeWrite(state, { value: path, dynamic: false, substitutions: [] }, context.cwd, new Map(), "write");
  return { findings: state.findings, scratchWrites: state.scratchWrites };
}

/** A network tool of the provider (Claude `WebFetch` / `WebSearch`), as a verdict. */
export function networkVerdict(what: string): BoundaryVerdict {
  return { findings: [{ what, effects: NETWORK, unreadable: false }], scratchWrites: 0 };
}

/** A request that cannot be read (§D.4), as a verdict: only the owner allows it. */
export function unreadableVerdict(what: string): BoundaryVerdict {
  return { findings: [{ what, effects: SECURITY, unreadable: true }], scratchWrites: 0 };
}

/** A request that starts an agent outside the boundary (a Worker's `create_agent` for a provider that is not a Reviewer's), as a verdict. */
export function securityVerdict(what: string): BoundaryVerdict {
  return { findings: [{ what, effects: SECURITY, unreadable: false }], scratchWrites: 0 };
}

/** The effects a held request's Allow declares (§D.2): each finding's first, `security` for an unreadable one, in `EFFECTS` order. */
export function declaredEffectsOf(findings: readonly HeldFinding[]): Effect[] {
  return realEffects(findings.map((finding) => (finding.unreadable ? "security" : finding.effects[0]!)));
}

/** The class a held request is of (§B.1): the riskiest of its declared effects. */
export function heldClassOf(findings: readonly HeldFinding[]): DecisionClass {
  return classOfEffects(declaredEffectsOf(findings)) ?? "security";
}
