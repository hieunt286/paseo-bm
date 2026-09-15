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
      "The installed Paseo is not a version paseo-bm supports: it requires Paseo 0.8.0 or newer, with the CLI and the daemon reporting the same version.",
    remediation:
      "Upgrade Paseo so the CLI and the daemon are both 0.8.0 or newer and agree on the version, then run the command again.",
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
  E_BAD_SKILLS_AGENTS: {
    code: "E_BAD_SKILLS_AGENTS",
    message: "The value of `--skills-agents` is not a valid agent list.",
    remediation:
      "Pass at most 8 comma-separated names, each matching ^[a-z0-9][a-z0-9_-]{0,31}$, for example `--skills-agents claude,codex`. Nothing was written.",
  },
  E_BAD_ROLE_SPEC: {
    code: "E_BAD_ROLE_SPEC",
    message: "The value of `--role` is not a valid role specification.",
    remediation:
      "Use `--role <role>=<provider>/<model>` where the role is manager, worker or reviewer, for example `--role worker=codex/gpt-5.6-sol`. Nothing was written.",
  },
  E_CONFIG_CONCURRENT_WRITE: {
    code: "E_CONFIG_CONCURRENT_WRITE",
    message:
      "Another process changed the Paseo config file while paseo-bm was updating it, and the single retry hit the same conflict.",
    remediation:
      "Close anything else editing Paseo configuration — the Paseo settings screen or another paseo-bm run — then run the command again. The other process's version of the file was kept.",
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
  E_PROVIDER_UNAVAILABLE: {
    code: "E_PROVIDER_UNAVAILABLE",
    message: "The provider or model requested for an agent role does not exist in this Paseo installation.",
    remediation:
      "Check which providers and models Paseo offers, then pick an existing pair for the role, for example `--role worker=<provider>/<model>`. Nothing was written.",
  },
  W_SKILLS_MISSING: {
    code: "W_SKILLS_MISSING",
    message: "Some agent skills that the paseo-bm roles rely on are not installed for the selected agents.",
    remediation:
      "Run the printed `skills add` command yourself, or re-run install with `--install-skills` to let paseo-bm run it after you consent. This never blocks the install or changes the exit code.",
  },
  W_BEADS_CLI_MISSING: {
    code: "W_BEADS_CLI_MISSING",
    message: "The beads CLI (`br` or `bd`) was not found, so Worker will not be able to manage beads.",
    remediation:
      "Install the beads CLI and make sure it is on PATH. paseo-bm installs fine without it; only the beads part of the workflow is unavailable.",
  },
  W_SKILLS_ASSIST_FAILED: {
    code: "W_SKILLS_ASSIST_FAILED",
    message: "The `skills` command that paseo-bm ran on your behalf did not finish successfully.",
    remediation:
      "Run the printed command manually to see the failure, then re-run `paseo-bm doctor`. Skills problems never block the install or change the exit code.",
  },
  W_PROVIDER_NOT_LOGGED_IN: {
    code: "W_PROVIDER_NOT_LOGGED_IN",
    message: "The provider chosen for an agent role has no active login session, so that role cannot start a session yet.",
    remediation:
      "Run that tool's own login command — paseo-bm never handles credentials — then run `paseo-bm doctor` to confirm. The role stays registered either way.",
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
