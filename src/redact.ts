/**
 * Secret masking — the last thing that touches text on its way out
 * (Technical Design §7, "Bí mật").
 *
 * The rule this module exists to enforce is *where* masking happens, not how
 * clever it is: a filter is applied once, at the final exit of each of the
 * three output channels — the human table, the `--json` document, and the
 * `--verbose` stream. Masking at each print site instead would be a promise
 * nobody can keep; one new `stderr(...)` call in a future work package is all
 * it takes to leak. Here there are exactly three seams, and both report
 * renderers apply one *by default*, so forgetting to pass a redactor makes the
 * output safe rather than unsafe.
 *
 * What counts as a secret is a constant, from Design §7:
 *
 * - the *values* of {@link SECRET_ENV_VARS}, masked wherever they appear, and
 * - password-shaped argv tokens ({@link SECRET_ARGV_FLAGS}) together with the
 *   value that follows them, so an echoed command line (Design §7, trust
 *   boundary 2 prints the command verbatim before running it) cannot carry a
 *   credential that never passed through our environment.
 *
 * Two properties are load-bearing:
 *
 * 1. **JSON stays JSON.** The `--json` channel carries exactly one parseable
 *    document (Design §4.4); masking may not truncate it or break a string.
 *    {@link createJsonRedactor} therefore parses, masks *inside* the values,
 *    and re-serializes, so the mask is always a well-formed JSON string no
 *    matter what characters the secret contained.
 * 2. **No length threshold.** Any non-blank value of a secret environment
 *    variable is masked, even a one-character one. The cost is cosmetic — a
 *    degenerate password like `a` garbles the human table — and the benefit is
 *    that there is no undocumented value below which protection silently stops.
 *
 * This module reads nothing from disk and never stores what it masks.
 */

/** What every masked value is replaced with. JSON-safe on purpose: no quotes, no backslashes. */
export const REDACTED = "[redacted]";

/** Environment variables whose *value* is masked wherever it appears (Design §7). */
export const SECRET_ENV_VARS: readonly string[] = ["PASEO_PASSWORD", "PASEO_DAEMON_PASSWORD"];

/** Argv flags whose following value is a credential (Design §7). */
export const SECRET_ARGV_FLAGS: readonly string[] = ["--password", "--token", "--secret"];

/** A final-pass filter over outgoing text. */
export type Redactor = (text: string) => string;

export interface RedactorOptions {
  /** Environment the secret values are read from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Argv of this run. Values passed after a password-shaped flag become
   * literal secrets, so they are masked everywhere — not only where they
   * happen to sit next to their flag.
   */
  readonly argv?: readonly string[];
  /** Extra literal values to mask, for a caller that knows of one. */
  readonly secrets?: readonly string[];
  /** Replacement text. Defaults to {@link REDACTED}. */
  readonly mask?: string;
}

/**
 * Password-shaped argv tokens inside arbitrary text.
 *
 * The value is either quoted, or a run that stops at whitespace, `"` or `\`.
 * Stopping at `"` is what keeps a masked command line embedded in a JSON
 * string from swallowing the closing quote of that string.
 */
const ARGV_SECRET_PATTERN = /(--(?:password|token|secret))(=[ \t]*|[ \t]+)("[^"]*"|'[^']*'|[^\s"\\]+)/g;

/** Flags whose *next* argv element is the credential. */
const SECRET_FLAG_SET: ReadonlySet<string> = new Set(SECRET_ARGV_FLAGS);

/**
 * Every literal value this run must never print: the secret environment
 * variables, anything handed after a password-shaped flag on the command line,
 * and whatever the caller added. Blank values are dropped — an unset or empty
 * variable is not a secret, and matching an empty string would mask the whole
 * document.
 */
export function collectSecrets(options: RedactorOptions = {}): string[] {
  const env = options.env ?? process.env;
  const found: string[] = [];

  for (const name of SECRET_ENV_VARS) {
    const value = env[name];
    if (typeof value === "string") found.push(value);
  }
  if (options.argv !== undefined) {
    found.push(...argvSecretValues(options.argv));
  }
  if (options.secrets !== undefined) {
    found.push(...options.secrets);
  }

  const kept = new Set(found.filter((value) => value.trim().length > 0));
  // Longest first: a secret that contains another one must be masked as a whole.
  return [...kept].sort((a, b) => b.length - a.length);
}

/** Values that followed a password-shaped flag in `argv`. */
function argvSecretValues(argv: readonly string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    const equals = token.indexOf("=");
    if (equals > 0 && SECRET_FLAG_SET.has(token.slice(0, equals))) {
      values.push(token.slice(equals + 1));
      continue;
    }
    if (SECRET_FLAG_SET.has(token)) {
      const next = argv[index + 1];
      // `--token --json` is a missing value, not a secret called `--json`.
      if (next !== undefined && !next.startsWith("-")) {
        values.push(next);
        index += 1;
      }
    }
  }
  return values;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Forms one secret can take in outgoing text: as typed, and as JSON would
 * escape it. Without the second form a password containing a quote, a
 * backslash or a newline would survive inside a JSON string untouched.
 */
function secretForms(secret: string): string[] {
  const escaped = JSON.stringify(secret).slice(1, -1);
  return escaped === secret ? [secret] : [secret, escaped];
}

function literalPattern(secrets: readonly string[]): RegExp | undefined {
  const forms = secrets.flatMap(secretForms);
  if (forms.length === 0) return undefined;
  return new RegExp(forms.map(escapeRegExp).join("|"), "g");
}

/**
 * Build the filter for the human and `--verbose` channels: literal secret
 * values first, then password-shaped argv tokens in whatever is left.
 */
export function createRedactor(options: RedactorOptions = {}): Redactor {
  const mask = options.mask ?? REDACTED;
  const literals = literalPattern(collectSecrets(options));

  return (text: string): string => {
    const withoutLiterals = literals === undefined ? text : text.replace(literals, mask);
    return withoutLiterals.replace(
      ARGV_SECRET_PATTERN,
      (_match, flag: string, separator: string) => `${flag}${separator}${mask}`,
    );
  };
}

/** One-shot form of {@link createRedactor}, for a caller that masks a single string. */
export function redactText(text: string, options: RedactorOptions = {}): string {
  return createRedactor(options)(text);
}

export interface JsonRedactorOptions extends RedactorOptions {
  /** Indentation of the re-serialized document. Detected from the input when omitted. */
  readonly indent?: number;
}

/**
 * Build the filter for the `--json` channel.
 *
 * Masking a JSON document as if it were flat text is how a secret containing a
 * quote turns stdout into something no consumer can parse. So this parses the
 * document, masks inside each string, key and number, and re-serializes:
 * whatever the secret looked like, the result is still exactly one document.
 *
 * When there is nothing to mask the input is returned byte-for-byte, so the
 * renderer's output is unchanged on the overwhelmingly common path.
 */
export function createJsonRedactor(options: JsonRedactorOptions = {}): Redactor {
  const mask = options.mask ?? REDACTED;
  const redact = createRedactor(options);

  return (text: string): string => {
    const masked = redact(text);
    if (masked === text) return text;

    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      // Not a JSON document after all. The text filter is still applied, which
      // is the safe half of the bargain.
      return masked;
    }

    const indent = options.indent ?? detectIndent(text);
    const trailingNewline = text.endsWith("\n") ? "\n" : "";
    return `${JSON.stringify(redactJsonValue(document, redact, mask), null, indent)}${trailingNewline}`;
  };
}

/**
 * Mask every string, key and number inside a parsed JSON value.
 *
 * A number is replaced by the mask *string* when its decimal form contains a
 * secret. That changes the type, which is the honest trade: a document that
 * says `"exitCode": "[redacted]"` is still parseable, and one that leaks is not
 * acceptable at any cost.
 */
export function redactJsonValue(value: unknown, redact: Redactor, mask: string = REDACTED): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const text = String(value);
    return redact(text) === text ? value : mask;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry, redact, mask));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[redact(key)] = redactJsonValue(entry, redact, mask);
    }
    return out;
  }
  return value;
}

/** Indent width of a `JSON.stringify(value, null, n)` document; `0` for a compact one. */
function detectIndent(text: string): number {
  const match = /^[[{]\r?\n([ \t]*)\S/.exec(text);
  return match?.[1]?.length ?? 0;
}

/**
 * Mask an argv before it is printed or logged, keeping its shape.
 *
 * Design §7 requires the command paseo-bm is about to run to be shown verbatim.
 * "Verbatim" has to stop at the credential: the flag stays visible so the user
 * can see what is being passed, the value does not.
 */
export function redactArgv(argv: readonly string[], options: RedactorOptions = {}): string[] {
  const mask = options.mask ?? REDACTED;
  const redact = createRedactor(options);
  const out: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    const equals = token.indexOf("=");
    if (equals > 0 && SECRET_FLAG_SET.has(token.slice(0, equals))) {
      out.push(`${token.slice(0, equals)}=${mask}`);
      continue;
    }
    if (SECRET_FLAG_SET.has(token)) {
      const next = argv[index + 1];
      out.push(token);
      if (next !== undefined && !next.startsWith("-")) {
        out.push(mask);
        index += 1;
      }
      continue;
    }
    out.push(redact(token));
  }

  return out;
}

/** A sink that masks what is written through it. Call {@link RedactingWriter.flush} at the end of a run. */
export interface RedactingWriter {
  (chunk: string): void;
  /** Emit the last line when it was written without a trailing newline. */
  flush(): void;
}

/**
 * Wrap a writer so the `--verbose` stream leaves through the same filter as the
 * other two channels.
 *
 * Text is held back until a newline arrives, because a secret split across two
 * `write` calls would otherwise pass through untouched — the one way a
 * chunk-by-chunk filter leaks. The consequence is an obligation: a final line
 * written without a newline stays buffered until `flush()`.
 */
export function createRedactingWriter(
  sink: (chunk: string) => void,
  redact: Redactor = createRedactor(),
): RedactingWriter {
  let pending = "";

  const writer = (chunk: string): void => {
    pending += chunk;
    const lastBreak = pending.lastIndexOf("\n");
    if (lastBreak < 0) return;
    const complete = pending.slice(0, lastBreak + 1);
    pending = pending.slice(lastBreak + 1);
    sink(redact(complete));
  };

  writer.flush = (): void => {
    if (pending.length === 0) return;
    const rest = pending;
    pending = "";
    sink(redact(rest));
  };

  return writer;
}
