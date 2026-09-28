# ADR-003 — Delegate installing skills to the `skills` CLI; paseo-bm does not write skill files itself

| Field | Value |
|---|---|
| Status | Accepted |
| Date | 2026-09-14 |
| Owner | hieu.nt10 |
| Amended by | [ADR-012](ADR-012-plugin-is-the-product.md) (2026-09-25): the **plugin**, not the installer, runs the `skills` CLI after the user clicks and confirms on Setup. Decision 3: there is no longer a non-interactive flag; decision 4: the target agents are fixed to Claude Code and Codex, `--skills-agents` is dropped; decision 5: a constant command string runs through a login shell (like installing `br`/`bv`) so that `npx` is on the PATH, instead of "argv array, no shell" — no part of the string comes from input; decisions 1, 2, 6–9 are unchanged |
| Related | [PRD REQ-007, REQ-015, Appendix A](../product/paseo-bm-prd.md#12-appendix-a--survey-of-the-recommended-skills-source), [ADR-002](ADR-002-install-ownership-model.md), [Technical Design](../design/paseo-bm.md) |

## Context

The plugin is effective when the machine already has the bead skills. The PRD settles two things that look contradictory: paseo-bm **does not copy skills itself** (REQ-007c), yet it must still **help the user install them** when they are missing (REQ-007d, e).

The reality on the machine (2026-09-14):

- The skills directories already have several owners: `~/.agents/skills` is where the files really live, `~/.claude/skills` is mostly symlinks pointing there; installs are tracked by `~/.agents/.skill-lock.json` with `source`, `sourceType`, `skillFolderHash`.
- The 5 bead skills on the owner's machine are managed by the `skills` CLI, sourced from an internal repository, and are **byte-for-byte identical** to the public repository `cuongntr/agent-skills`.
- The `skills` CLI (npm `skills`, version 1.5.26) has: `add <repo>` with `-g/--global`, `-a/--agent`, `-s/--skill`, `-y/--yes`, `--copy`, `--all`, and `-l/--list` to **list the skills in a repository without installing**. When run inside an agent environment, it detects this and switches to non-interactive mode.

If paseo-bm copied skills itself, it would overwrite files owned by the `skills` CLI, corrupt that tool's lockfile, and take on the responsibility of redistributing another author's content (the repository has no LICENSE yet).

## Decision

1. paseo-bm **never** creates, edits, deletes or backs up a file in a skills directory. The right to write there belongs to the `skills` CLI.
2. **Detect** by reading the file system: for each skill in the required list, check whether `<skills dir>/<skill name>/SKILL.md` exists, in `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, honouring `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, and following symlinks. The `skills` CLI is not called for detection, because detection must be fast, work offline and have no side effects.
3. **Help install** by calling the `skills` CLI itself with the source `cuongntr/agent-skills`, only after the user has consented and has seen the exact command that will run. In non-interactive mode, a separate permission flag is required.
4. **The skills source is a constant in the package**; Phase 1 does not allow overriding it (Q-011). The only part the user may supply is **the list of target agents** (decided 2026-09-14, Q-014 in the Technical Design), through the `--skills-agents` flag or a question in the wizard, with `claude,codex` suggested by default. Because this is user data going into an external command, each element must match `^[a-z0-9][a-z0-9_-]{0,31}$`, at most 8 elements, duplicates removed, an element starting with `-` refused; if invalid, stop and run nothing.
5. Run that command as a child process, passing argv as an array, **without a shell**, with its output piped straight to the terminal so the user sees what is happening. Use the `skills` CLI's **default symlink mode**, not `--copy` (Q-015), to match the layout already on the machine: `~/.claude/skills` pointing to `~/.agents/skills`.
   *(Added 2026-09-15)* When `--json` is on, the child process's output goes to **stderr** rather than stdout, so that stdout is always exactly one JSON document (REQ-013c). The child process has a **300-second** time limit, and **60 seconds** without output produces a warning; on timeout it is killed, a warning is recorded, and the exit code does not change.
6. After the command ends, **detect again** and report the before/after result. Success or failure of this step does not change the exit code of the plugin install command.
7. No `skills` CLI, no network, or a failed command → print manual instructions (the command itself, for the user to run) and continue.
8. Uninstalling paseo-bm does **not** uninstall skills; the summary shows the `skills` CLI command for removing them yourself.
9. The README states clearly that the skills source is another author's repository, and that the installation is done by a third-party tool — that tool has its own install data collection, outside paseo-bm's "no telemetry" commitment.
   *(Added 2026-09-18, [delta short-readme](../archive/product/paseo-bm-prd-delta-20260918b-short-readme.md))* The README is now short: it still states that the skills source is another author's repository; the part about the third-party `skills` CLI, its own data collection channel and the symlink-style install lives in `GUIDE.md` at the repository root, which the README points to.

## Consequences

**Positive**
- No dispute over file ownership, no risk of throwing the `skills` CLI's lockfile out of sync.
- Another author's content is not redistributed, so the licensing problem is avoided.
- A new user is still led to the goal with a single command, true to the spirit of the PRD.
- Detection runs offline and is cheap, so it can also be used in `doctor`.

**Negative / to be accepted**
- Depends on two things outside our control: the `skills` CLI and another author's repository. If the command-line interface or a skill directory name changes, the help flow breaks. Mitigated by: non-blocking errors, manual instructions always available, and tests against a fake.
- Detection goes by directory name, so it cannot tell whether a skill's content is stale; the repository has no tags yet, so Phase 1 does not compare versions (Q-013).
- Running a process that downloads code from the network is a real trust boundary. Mitigated by: explicit consent, showing the exact command, a source fixed in the package.
- Letting the user enter agent names avoids guessing the `skills` CLI's identifiers, but opens a path for user data into an external command. The validation in decision 4 is mandatory, and there must be tests for bad inputs.
- Choosing symlinks means the agents' skills share one copy; editing the original is seen by every agent at once. That is the desired behaviour on the owner's machine, but it must be stated in the README so users are not surprised.

## Alternatives considered

| Option | Reason rejected |
|---|---|
| Pack the skills into the npm package and copy them ourselves | Overwrites files owned by another tool; redistributes another author's content while the repository has no LICENSE; a copy we would have to maintain ourselves |
| `git clone` ourselves, then copy | Still writing into the skills directory ourselves, plus handling updates and conflicts ourselves — that is, rewriting the `skills` CLI |
| Only print instructions, no help at all | The owner's explicit requirement is help all the way; a newcomer would stop at this step |
| Detect by calling `skills list` | Slower, needs that tool to exist, and depends on a third party's output format for a job that only needs to read files |
| Allow changing the skills source through a flag from Phase 1 | Opens a path for user-supplied parameters into an external command; deferred until there is a real need (Q-011) |
| Guess the agent identifiers instead of asking the user | The identifiers are defined by the `skills` CLI and may change; a wrong guess silently breaks the help flow |
| Use `--copy` so that each agent has its own copy | Diverges from the symlink layout the machine uses; creates several copies to keep in sync by hand |

## Revision

| Date | Change |
|---|---|
| 2026-09-14 | First version, Accepted |
| 2026-09-14 | Revised decisions 4 and 5 per the owner's decision: let the user enter the agent list (with validation rules) and use the default symlink mode. Added the corresponding consequences and rejected alternatives |
