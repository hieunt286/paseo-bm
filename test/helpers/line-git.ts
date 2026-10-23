import { GIT_READ_ONLY_PREFIX, type GitRunner } from "../../plugin/server/repo-tool";

/** What a fake worktree answers to the line's read-only git (delivery line design §4.5, §4.7); a missing answer fails. */
export interface FakeLine {
  /** `rev-list --left-right --count origin/<target>...HEAD`: "<behind>\t<ahead>". */
  counts?: string;
  /** `status --porcelain`. */
  status?: string;
  /** `log -1 --format=%cI`. */
  lastCommitAt?: string;
  /** `rev-parse HEAD`. */
  head?: string;
  /** `rev-parse --abbrev-ref HEAD`. */
  branch?: string;
  /** `rev-list --count origin/<branch>..HEAD`; absent: not pushed. */
  aheadOfOrigin?: string;
  /** `log --format=%cI origin/<target>..HEAD`, newest first. */
  aheadLog?: string;
  /** `diff --name-only origin/<target>...<branch>`. */
  diff?: string;
}

/** A git runner answering each worktree (by its folder) as `lines` says, and every call it got. */
export function fakeLineGit(lines: Readonly<Record<string, FakeLine>>): { git: GitRunner; calls: Array<{ cwd: string; args: string[] }> } {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const git: GitRunner = async (all, { cwd }) => {
    const args = all.slice(GIT_READ_ONLY_PREFIX.length);
    calls.push({ cwd, args });
    const line = lines[cwd];
    const key: keyof FakeLine | null =
      args[0] === "rev-list"
        ? args[1] === "--left-right"
          ? "counts"
          : "aheadOfOrigin"
        : args[0] === "status"
          ? "status"
          : args[0] === "log"
            ? args[1] === "-1"
              ? "lastCommitAt"
              : "aheadLog"
            : args[0] === "rev-parse"
              ? args[1] === "HEAD"
                ? "head"
                : "branch"
              : args[0] === "diff"
                ? "diff"
                : null;
    const out = line === undefined || key === null ? undefined : line[key];
    if (out === undefined) throw new Error(`git ${args.join(" ")} failed`);
    return { stdout: out };
  };
  return { git, calls };
}
