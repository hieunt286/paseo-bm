/**
 * Exit-code table — the single source of truth for Technical Design §4.3.
 *
 * The number a process returns is a published contract: scripts branch on it.
 * Inside one major version a code may gain wording, never a new meaning, and
 * `src/flags.ts` re-exports this table rather than keeping a second copy of it.
 *
 * Note that 0 and 6 are deliberately different. Code 0 means "a preview that
 * was asked for, on purpose"; code 6 means "this ran in a script that forgot
 * `--apply`, so a preview was printed and nothing was written". Collapsing the
 * two would let automation read "nothing happened" as "success".
 *
 * This module maps *situations* to exit codes. It deliberately does not map
 * diagnostic codes (`src/errors.ts`) to exit codes: Design §4.4 never connects
 * the two tables, and inventing that link here would quietly become a contract.
 */

/** Design §4.3, in numeric order. */
export const EXIT_CODES = {
  /** Success, an intentional preview, or a healthy `doctor`. */
  ok: 0,
  /** `doctor` found drift inside what paseo-bm owns. */
  doctorDrift: 1,
  /** Misuse of a command or flag. */
  usage: 2,
  /** Environment precondition failed — nothing was written. */
  preflight: 3,
  /** Installed, but a trust boundary was not consented to. */
  consentMissing: 4,
  /** Stopped on a conflict that needs a human decision. */
  conflict: 5,
  /** No TTY and no `--apply`: the preview was printed, nothing was written. */
  noTtyNoApply: 6,
  /**
   * Files were installed, but Paseo could not install or load the plugin
   * (Design §4.3 errata 2026-09-15). Unlike 3, something was written.
   */
  pluginLoadFailed: 7,
} as const;

/** The names above, e.g. `"noTtyNoApply"`. */
export type ExitCodeName = keyof typeof EXIT_CODES;

/** Every value the process may exit with. */
export type ExitCode = (typeof EXIT_CODES)[ExitCodeName];

/** One row of the Design §4.3 table. */
export interface ExitCodeSpec {
  readonly code: ExitCode;
  readonly name: ExitCodeName;
  /** One line, as printed by `--help` and used in reports. */
  readonly meaning: string;
}

/** The table in numeric order; `--help` and the human report both read it. */
export const EXIT_CODE_SPECS: readonly ExitCodeSpec[] = [
  { code: EXIT_CODES.ok, name: "ok", meaning: "success, an intentional preview, or a healthy doctor" },
  { code: EXIT_CODES.doctorDrift, name: "doctorDrift", meaning: "doctor found drift in what paseo-bm owns" },
  { code: EXIT_CODES.usage, name: "usage", meaning: "misuse of a command or flag" },
  { code: EXIT_CODES.preflight, name: "preflight", meaning: "environment precondition failed; nothing was written" },
  {
    code: EXIT_CODES.consentMissing,
    name: "consentMissing",
    meaning: "installed, but a trust boundary was not consented to",
  },
  { code: EXIT_CODES.conflict, name: "conflict", meaning: "stopped on a conflict that needs a human decision" },
  {
    code: EXIT_CODES.noTtyNoApply,
    name: "noTtyNoApply",
    meaning: "no terminal and no --apply; preview printed, nothing written",
  },
  {
    code: EXIT_CODES.pluginLoadFailed,
    name: "pluginLoadFailed",
    meaning: "files installed, but Paseo could not install or load the plugin",
  },
];

const SPEC_BY_CODE = new Map<number, ExitCodeSpec>(EXIT_CODE_SPECS.map((spec) => [spec.code, spec]));

/** True when a number is one of the eight codes paseo-bm may exit with. */
export function isExitCode(value: number): value is ExitCode {
  return SPEC_BY_CODE.has(value);
}

/** The one-line meaning of a code, for help text and reports. */
export function exitCodeMeaning(code: ExitCode): string {
  // Every ExitCode has a row; the fallback only exists to keep the return typed.
  return SPEC_BY_CODE.get(code)?.meaning ?? "";
}

/** What decided a preview: whether the run could ask, and whether `--apply` was given. */
export interface PreviewSituation {
  /** True when both ends are a terminal, i.e. the run could have asked to confirm. */
  readonly interactive: boolean;
  /** True when `--apply` was on the command line. */
  readonly apply: boolean;
}

/**
 * Exit code for a run that ended at the preview.
 *
 * A preview reached from a terminal — or one the user stopped on purpose after
 * passing `--apply` — is a normal outcome, so it is 0. A preview produced with
 * no terminal and no `--apply` is code 6: the caller almost certainly meant to
 * write something, and must not read the run as a success.
 */
export function previewExitCode(situation: PreviewSituation): ExitCode {
  if (situation.apply || situation.interactive) {
    return EXIT_CODES.ok;
  }
  return EXIT_CODES.noTtyNoApply;
}
