/**
 * Diagnostic registry — the single, closed list of error and warning codes that
 * paseo-bm may emit (Technical Design §4.4).
 *
 * These codes are a public contract from the first release: inside one major
 * version codes may only be ADDED. An existing code must never be renamed,
 * removed, or given a different meaning — scripts and `--json` consumers match
 * on them.
 *
 * No other module may invent a code inline; import it from here so that
 * `E_DAEMON_UNREACHABLE` and `E_DAEMON_DOWN` can never both exist in one
 * binary. `test/errors.test.ts` scans `src/` and fails on any code literal that
 * is not a key of this registry.
 */

/** Shape every registry entry must have. Each field is user-facing and required. */
interface DiagnosticDeclaration {
  /** Stable identifier, equal to the key it is registered under. */
  readonly code: string;
  /** What went wrong, in one sentence. */
  readonly message: string;
  /** What the user can do about it. */
  readonly remediation: string;
}

/**
 * The registry. Keys are the codes themselves; `E_` is an error, `W_` is a
 * warning that never changes the exit code (Technical Design §4.3).
 */
export const DIAGNOSTICS = {
  E_DAEMON_UNREACHABLE: {
    code: "E_DAEMON_UNREACHABLE",
    message: "The Paseo daemon did not answer, so the environment could not be checked.",
    remediation:
      "Open the Paseo app so its daemon is running, then run the command again. Nothing has been written yet.",
  },
  E_VERSION_MISMATCH: {
    code: "E_VERSION_MISMATCH",
    message:
      "The installed Paseo is not a version paseo-bm supports: it requires Paseo 0.9.0 or newer, with the CLI and the daemon reporting the same version.",
    remediation:
      "Upgrade Paseo so the CLI and the daemon are both 0.9.0 or newer and agree on the version, then run the command again. On Paseo 0.8, keep paseo-bm@0.3.1.",
  },
  E_COMMAND_RETIRED: {
    code: "E_COMMAND_RETIRED",
    message: "That command or flag was retired in paseo-bm 0.4.0, which only migrates an old install to the npm plugin.",
    remediation:
      "Everything the CLI used to do is now in the plugin: open Beads Manager → Setup. See https://github.com/hieunt286/paseo-bm#readme",
  },
  E_UNSUPPORTED_OS: {
    code: "E_UNSUPPORTED_OS",
    message: "This operating system is not supported: paseo-bm runs on macOS and Linux.",
    remediation:
      "Run paseo-bm on macOS or Linux. On native Windows it cannot install; WSL behaves like Linux but is not covered by Phase 1 testing.",
  },
  E_NODE_TOO_OLD: {
    code: "E_NODE_TOO_OLD",
    message: "This Node.js runtime is older than the minimum paseo-bm supports (Node 22).",
    remediation: "Install Node.js 22 or newer, then run `npx paseo-bm` again.",
  },
  E_PASEO_CLI_MISSING: {
    code: "E_PASEO_CLI_MISSING",
    message: "The `paseo` command was not found, so paseo-bm cannot talk to Paseo.",
    remediation:
      "Install the Paseo CLI and make sure `paseo --version` works in this shell, then run the command again.",
  },
  E_PASEO_OUTPUT_UNEXPECTED: {
    code: "E_PASEO_OUTPUT_UNEXPECTED",
    message: "A Paseo CLI command returned output that does not match the JSON shape paseo-bm expects.",
    remediation:
      "Re-run with `--verbose` to see the raw output and confirm the Paseo version is supported; report the mismatch if it is. Nothing was written from the unexpected output.",
  },
  E_CONFLICT: {
    code: "E_CONFLICT",
    message: "Something paseo-bm does not own is in the way, so the run stopped for a human decision.",
    remediation:
      "Inspect the reported target and move it aside yourself, or re-run with `--force` to overwrite files recorded as user-modified. A backup is always taken before overwriting.",
  },
  E_RECORD_SCHEMA_TOO_NEW: {
    code: "E_RECORD_SCHEMA_TOO_NEW",
    message: "The install record was written by a newer paseo-bm and uses a schema version this build does not understand.",
    remediation:
      "Upgrade paseo-bm (`npx paseo-bm@latest`) so it can read the record. Do not hand-edit or delete install.json; that is the only record of what is owned.",
  },
  E_LOCKED: {
    code: "E_LOCKED",
    message: "Another paseo-bm install or uninstall already holds the lock on this install home.",
    remediation:
      "Wait for the other run to finish and try again. If you are certain no other run is active, delete the `.lock` file in the install home first. `paseo-bm doctor` never needs the lock.",
  },
  E_UNSAFE_INSTALL_HOME: {
    code: "E_UNSAFE_INSTALL_HOME",
    message: "The install home is not a safe place for paseo-bm to own, for example an empty path, the home directory itself, or a directory that belongs to Paseo or to an agent.",
    remediation:
      "Point `--home` (or `PASEO_BM_HOME`) at a dedicated directory such as `~/.paseo-bm`, then run the command again. Nothing was written.",
  },
  E_PATH_ESCAPE: {
    code: "E_PATH_ESCAPE",
    message: "A path paseo-bm was about to use resolves outside the directory it is allowed to write to, so the operation was refused.",
    remediation:
      "Check the reported path and the install record for an entry that points outside the install home. paseo-bm never follows such a path; nothing outside the install home was written.",
  },
  E_SYMLINK_IN_PATH: {
    code: "E_SYMLINK_IN_PATH",
    message: "A path paseo-bm was about to write to goes through a symbolic link, so the operation was refused.",
    remediation:
      "Replace the reported symlink with a real directory, or choose another `--home`. paseo-bm never writes through a symlink, so nothing was written through it.",
  },
  E_TARGET_NOT_WRITABLE: {
    code: "E_TARGET_NOT_WRITABLE",
    message: "The install home, or the nearest existing directory above it, is not writable by the current user.",
    remediation:
      "Fix the permissions on the reported directory, or point `--home` at a directory you own, then run the command again. Nothing was written.",
  },
  E_PLUGIN_LOAD_FAILED: {
    code: "E_PLUGIN_LOAD_FAILED",
    message: "paseo-bm installed its files, but Paseo could not install or load the plugin.",
    remediation:
      "Run `paseo plugin logs paseo-bm` to see why, fix the cause, then run `npx paseo-bm install --apply` again. The installed files were kept.",
  },
  W_PLUGINS_DISABLED: {
    code: "W_PLUGINS_DISABLED",
    message: "Paseo reports the plugin as disabled: Paseo's own plugins switch is off.",
    remediation: "Turn plugins on in Paseo's settings; the switch is Paseo's and paseo-bm never writes it.",
  },
  W_BEADS_CLI_MISSING: {
    code: "W_BEADS_CLI_MISSING",
    message: "The beads CLI (`br` or `bd`) was not found, so Worker will not be able to manage beads.",
    remediation:
      "Install br (beads_rust) and make sure it is on PATH: `brew install dicklesworthstone/tap/br`, or `curl -fsSL https://raw.githubusercontent.com/Dicklesworthstone/beads_rust/main/install.sh | bash -s -- --skip-skills`. The Beads Manager Setup screen can also install it. paseo-bm installs fine without it; only the beads part of the workflow is unavailable.",
  },
  W_BEADS_VIEWER_MISSING: {
    code: "W_BEADS_VIEWER_MISSING",
    message: "The beads viewer (`bv`) was not found, so agents cannot use its triage and dependency views.",
    remediation:
      "Install bv (beads_viewer) and make sure it is on PATH: `brew install dicklesworthstone/tap/bv`, or the pinned script in the beads_viewer README. The Beads Manager Setup screen can also install it. This never blocks the install or changes the exit code.",
  },
} as const satisfies Readonly<Record<string, DiagnosticDeclaration>>;

/** Every code in the registry — using a name that is not registered is a compile error. */
export type DiagnosticCode = keyof typeof DIAGNOSTICS;

/** Codes that describe a failure. */
export type ErrorCode = Extract<DiagnosticCode, `E_${string}`>;

/** Codes that describe a warning; warnings never change the exit code. */
export type WarningCode = Extract<DiagnosticCode, `W_${string}`>;

/** A registry entry: code, message and remediation. */
export type Diagnostic = (typeof DIAGNOSTICS)[DiagnosticCode];

/** Every registered code, in declaration order. */
export const DIAGNOSTIC_CODES: readonly DiagnosticCode[] = Object.keys(DIAGNOSTICS) as DiagnosticCode[];

/**
 * Shape of a diagnostic code literal. Used by the source scan in
 * `test/errors.test.ts` to find codes that were written inline instead of
 * being registered here.
 */
export const DIAGNOSTIC_CODE_PATTERN = /^[EW]_[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

/** Look up a registry entry; the return type is narrowed to the exact entry. */
export function diagnostic<Code extends DiagnosticCode>(code: Code): (typeof DIAGNOSTICS)[Code] {
  return DIAGNOSTICS[code];
}

/** True when an arbitrary string is a registered code. */
export function isDiagnosticCode(value: string): value is DiagnosticCode {
  return Object.prototype.hasOwnProperty.call(DIAGNOSTICS, value);
}

/** True when an arbitrary string is a registered error code. */
export function isErrorCode(value: string): value is ErrorCode {
  return isDiagnosticCode(value) && value.startsWith("E_");
}

/** True when an arbitrary string is a registered warning code. */
export function isWarningCode(value: string): value is WarningCode {
  return isDiagnosticCode(value) && value.startsWith("W_");
}
