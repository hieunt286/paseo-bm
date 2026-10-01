/**
 * `bm_repo` (Orchestrator design §6B.4; code review 2026-09-30 §4): the
 * Orchestrator's one look at a project's repository. It runs a fixed
 * read-only `git` command (`execFile`, no shell) in the project's folder or a
 * folder inside it, or reads one file there. Nothing here writes to a
 * repository, fetches, pushes or runs a hook, and no file whose name marks it
 * as a secret is read: credentials are untouchable (AGENTS.md).
 */
import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { cutText } from "./request-render";
import { redactText } from "./collector";
import { listedWorkspaces } from "./paseo-directory";
import { refuse, requireProject, type ServerToolResult, type ToolContext } from "./orchestrator-tool-context";
import { firstLine } from "./request-trace";
import { readWorkspaceMeta } from "./trace-store";
import type { RepoAction } from "../shared/bm-tools";
import { errorText } from "./rpc-kit";

/** `bm_repo` (design §6B.4): the longest output handed out … */
export const REPO_OUTPUT_MAX_CHARS = 20_000;
/** … the largest file it reads (or git output it takes in) … */
export const REPO_FILE_MAX_BYTES = 200 * 1024;
/** … and how long one git command may run. */
export const REPO_TIMEOUT_MS = 10_000;

/**
 * What every git command of `bm_repo` starts with: no pager, no colour, and
 * no filesystem monitor (`core.fsmonitor` names a program git would run).
 * With `GIT_OPTIONAL_LOCKS=0` in its environment, `status` does not refresh
 * the index either, so nothing in the repository is written.
 */
export const GIT_READ_ONLY_PREFIX: readonly string[] = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "color.ui=false", "-c", "core.quotePath=false"];

/**
 * A file `bm_repo` never reads, by its name: environment files, keys,
 * certificates and credential stores. Credentials are untouchable (AGENTS.md).
 */
const SECRET_FILE_NAME = /^(?:\.env(?:\..*)?|\.envrc|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.htpasswd|credentials(?:\..*)?|secrets?(?:\..*)?)$/i;

/** Runs one git command; `execFile` of `git` without a shell by default (`runGit`). Rejects on a non-zero exit. */
export type GitRunner = (args: readonly string[], options: { cwd: string; maxBytes: number }) => Promise<{ stdout: string }>;

/** What `bm_repo` reads of the plugin's deps. */
export interface RepoToolDeps {
  /** How `bm_repo` runs git; `runGit` by default. */
  git?: GitRunner;
}

export interface RepoInput {
  workspaceId: string;
  action: RepoAction;
  path?: string;
  file?: string;
}

/** The environment git runs in: no prompt, no optional lock, no lazy fetch, and no repository named by the plugin's own environment. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]) {
    delete env[name];
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_PAGER: "cat", PAGER: "cat" };
}

/** The default `GitRunner`: `execFile("git", args)`, no shell, 10-second timeout, output capped at `maxBytes`. */
export const runGit: GitRunner = (args, { cwd, maxBytes }) =>
  new Promise((done, fail) => {
    execFile(
      "git",
      [...args],
      { cwd, env: gitEnv(), timeout: REPO_TIMEOUT_MS, maxBuffer: maxBytes, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) done({ stdout });
        else fail(Object.assign(error, { stderr }));
      },
    );
  });

/** True when `candidate` is `root` or lies below it. */
function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The real path of `path`, or a refusal saying what `what` is. */
function realOf(path: string, what: string): string {
  try {
    return realpathSync(path);
  } catch {
    return refuse(`${what} does not exist`);
  }
}

/** Why a git command failed, in one line, redacted. */
function gitFailure(error: unknown, command: string, env: NodeJS.ProcessEnv): string {
  const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; stderr?: string };
  if (failure.code === "ENOENT") return "git is not installed on this machine";
  if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return `the output of git ${command} is larger than ${REPO_FILE_MAX_BYTES / 1024} KB`;
  if (failure.killed === true || typeof failure.signal === "string") return `git ${command} took longer than ${REPO_TIMEOUT_MS / 1000} seconds`;
  const said = firstLine(typeof failure.stderr === "string" ? failure.stderr : "", env) ?? firstLine(errorText(error), env) ?? "no reason given";
  return `git ${command} failed: ${said}`;
}

/**
 * `bm_repo` (design §6B.4): one fixed read-only git command in the project's
 * folder — or a folder inside it, `path` — or one file read. The folder is the
 * one Paseo lists for the workspace (else the one the trace store last saw);
 * `path` and `file` are resolved through symlinks and refused when they leave
 * it or reach into `.git`. A file whose name marks it as a secret (`.env`, a
 * key, a credential store) is never read, nor a working-tree file git
 * ignores. Output is redacted and capped at 20,000 characters; a file or
 * output above 200 KB is refused. Nothing is written: `status` runs with
 * `GIT_OPTIONAL_LOCKS=0`, and no command fetches, pushes or runs a hook.
 */
export async function bmRepo(input: RepoInput, context: ToolContext, deps: RepoToolDeps): Promise<ServerToolResult> {
  await requireProject(input.workspaceId, context);
  const listed = await listedWorkspaces(context.paseo);
  const directory =
    listed?.find((entry) => entry.id === input.workspaceId)?.directory ?? readWorkspaceMeta(context.location, input.workspaceId)?.lastKnownDirectory ?? null;
  if (directory === null) refuse(`the folder of project ${input.workspaceId} is not known`);
  const root = realOf(directory, `the project's folder ${directory}`);
  const cwd = input.path === undefined ? root : realOf(resolve(root, input.path), `${input.path} (in the project's folder)`);
  if (!within(root, cwd)) refuse(`${input.path} is outside the project's folder`);
  if (!statSync(cwd).isDirectory()) refuse(`${input.path} is not a folder`);
  if (relative(root, cwd).split(sep).includes(".git")) refuse("the .git folder is not readable with bm_repo");
  const git = deps.git ?? runGit;
  const where = relative(root, cwd) || ".";

  const run = async (args: readonly string[], maxBytes = REPO_FILE_MAX_BYTES): Promise<string> => {
    try {
      return (await git([...GIT_READ_ONLY_PREFIX, ...args], { cwd, maxBytes })).stdout;
    } catch (error) {
      return refuse(gitFailure(error, args[0] ?? "", context.env));
    }
  };

  let title: string;
  let output: string;
  switch (input.action) {
    case "status":
      title = "git status --short --branch";
      output = await run(["status", "--short", "--branch"]);
      break;
    case "diff-stat": {
      title = "git diff --stat, then git diff --cached --stat";
      const unstaged = await run(["diff", "--stat", "--no-ext-diff", "--no-textconv"]);
      const staged = await run(["diff", "--cached", "--stat", "--no-ext-diff", "--no-textconv"]);
      output = `Not staged:\n${unstaged.trimEnd() || "(nothing)"}\n\nStaged:\n${staged.trimEnd() || "(nothing)"}`;
      break;
    }
    case "log":
      title = "git log --oneline -20";
      output = await run(["log", "--oneline", "-20", "--no-decorate"]);
      break;
    default: {
      if (input.file === undefined) refuse("show needs file: a path relative to the folder, or HEAD:<path> for its committed version");
      const committed = input.file.startsWith("HEAD:");
      const name = committed ? input.file.slice("HEAD:".length) : input.file;
      if (name === "" || isAbsolute(name)) refuse("file must be a path relative to the folder");
      const target = resolve(cwd, name);
      if (!within(root, target)) refuse(`${input.file} is outside the project's folder`);
      const refuseSecret = (path: string): void => {
        if (relative(root, path).split(sep).includes(".git")) refuse("the .git folder is not readable with bm_repo");
        if (SECRET_FILE_NAME.test(basename(path))) refuse(`${input.file} may hold secrets; bm_repo does not read it`);
      };
      refuseSecret(target);
      const relativeName = relative(cwd, target).split(sep).join("/");
      if (committed) {
        title = `git show HEAD:./${relativeName}`;
        output = await run(["show", "--no-textconv", `HEAD:./${relativeName}`]);
        break;
      }
      const real = realOf(target, input.file);
      if (!within(root, real)) refuse(`${input.file} leads outside the project's folder`);
      refuseSecret(real);
      const stat = statSync(real);
      if (!stat.isFile()) refuse(`${input.file} is not a file`);
      if (stat.size > REPO_FILE_MAX_BYTES) refuse(`${input.file} is larger than ${REPO_FILE_MAX_BYTES / 1024} KB`);
      // A file git ignores is often local configuration or data: not read (exit 0 = ignored, 1 = not).
      const ignored = await git([...GIT_READ_ONLY_PREFIX, "check-ignore", "-q", "--", relative(cwd, real)], { cwd, maxBytes: 64 * 1024 }).then(
        () => true,
        (error: unknown) => ((error as { code?: unknown }).code === 1 ? false : refuse(gitFailure(error, "check-ignore", context.env))),
      );
      if (ignored) refuse(`${input.file} is ignored by git; bm_repo reads only files git tracks or would track`);
      const content = readFileSync(real, "utf8");
      if (content.includes("\u0000")) refuse(`${input.file} is not a text file`);
      title = `${relativeName} (as it is now)`;
      output = content;
      break;
    }
  }
  const safe = redactText(output, context.env);
  const text = cutText(safe.trimEnd() === "" ? "(no output)" : safe.trimEnd(), REPO_OUTPUT_MAX_CHARS);
  return { ok: true, text: `${title} — in ${where} of project ${input.workspaceId}\n\n${text}` };
}
