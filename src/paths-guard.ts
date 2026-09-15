import { lstatSync } from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

/**
 * Why a path was refused. These are guard-level reasons, not user-facing error
 * codes: the error-code registry in Design §4.4 has no entry for path guards,
 * so callers map these onto whatever code fits their command.
 */
export type PathGuardReason =
  | "empty-path"
  | "outside-root"
  | "symlink-in-path"
  | "unsafe-install-home";

export class PathGuardError extends Error {
  readonly reason: PathGuardReason;
  /** The path that was refused, already resolved to an absolute path. */
  readonly path: string;
  /** The root, symlink or protected directory that caused the refusal. */
  readonly conflict: string | undefined;

  constructor(reason: PathGuardReason, message: string, path: string, conflict?: string) {
    super(message);
    this.name = "PathGuardError";
    this.reason = reason;
    this.path = path;
    this.conflict = conflict;
  }
}

export interface AbsoluteOptions {
  /** Base directory for relative input. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Home directory used to expand a leading `~`. Defaults to no expansion. */
  homeDir?: string;
}

/**
 * Normalise user-supplied path input into an absolute POSIX path.
 *
 * Handles the two shapes a flag or environment variable can arrive in: a
 * relative path (resolved against `cwd`) and a `~`-prefixed path (a shell would
 * have expanded it, an environment variable carries it verbatim).
 */
export function toAbsolutePath(input: string, options: AbsoluteOptions = {}): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new PathGuardError("empty-path", "Path is empty", input);
  }

  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir;

  let expanded = trimmed;
  if (homeDir !== undefined && homeDir.length > 0) {
    if (expanded === "~") {
      expanded = homeDir;
    } else if (expanded.startsWith(`~${sep}`)) {
      expanded = resolve(homeDir, expanded.slice(2));
    }
  }

  return resolve(cwd, expanded);
}

/**
 * True when `candidate` is `root` itself or lives underneath it.
 *
 * Purely lexical on the resolved paths — symlinks are deliberately not followed
 * here; `assertNoSymlinkInPath` is the check for those.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedRoot === resolvedCandidate) {
    return true;
  }
  const rel = relative(resolvedRoot, resolvedCandidate);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** True when `ancestor` strictly contains `descendant`. */
export function containsPath(ancestor: string, descendant: string): boolean {
  return resolve(ancestor) !== resolve(descendant) && isWithinRoot(ancestor, descendant);
}

/** Refuses any path that escapes `root`. Returns the resolved path. */
export function assertWithinRoot(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (!isWithinRoot(resolvedRoot, resolvedCandidate)) {
    throw new PathGuardError(
      "outside-root",
      `Path escapes its allowed root: ${resolvedCandidate} is not inside ${resolvedRoot}`,
      resolvedCandidate,
      resolvedRoot,
    );
  }
  return resolvedCandidate;
}

export interface SymlinkCheckOptions {
  /**
   * Directory that is trusted and therefore not inspected. Only the segments
   * strictly below it are checked. Without it the whole chain from the
   * filesystem root is inspected, which on macOS trips over system symlinks
   * such as `/var` -> `/private/var`.
   */
  root?: string;
}

/**
 * Refuses a path when any existing segment of it is a symbolic link, so a write
 * can never travel through a link out of the area we own. Segments that do not
 * exist yet are fine: they are what a fresh install is about to create.
 */
export function assertNoSymlinkInPath(target: string, options: SymlinkCheckOptions = {}): string {
  const resolvedTarget = resolve(target);
  const start = options.root === undefined ? parse(resolvedTarget).root : resolve(options.root);

  if (options.root !== undefined && !isWithinRoot(start, resolvedTarget)) {
    throw new PathGuardError(
      "outside-root",
      `Path escapes its allowed root: ${resolvedTarget} is not inside ${start}`,
      resolvedTarget,
      start,
    );
  }

  const rel = relative(start, resolvedTarget);
  const segments = rel.length === 0 ? [] : rel.split(sep).filter((segment) => segment.length > 0);

  let current = start;
  for (const segment of segments) {
    current = resolve(current, segment);
    const stats = lstatSync(current, { throwIfNoEntry: false });
    if (stats === undefined) {
      // Nothing exists from here down, so nothing can be a symlink.
      break;
    }
    if (stats.isSymbolicLink()) {
      throw new PathGuardError(
        "symlink-in-path",
        `Refusing to use a path that travels through a symlink: ${current}`,
        resolvedTarget,
        current,
      );
    }
  }

  return resolvedTarget;
}

/**
 * The check every write path goes through: inside the root we own, and not
 * reached through a symlink.
 */
export function assertSafeWritePath(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = assertWithinRoot(resolvedRoot, candidate);
  return assertNoSymlinkInPath(resolvedCandidate, { root: resolvedRoot });
}
