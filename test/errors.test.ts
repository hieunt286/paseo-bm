import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DIAGNOSTICS,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_CODE_PATTERN,
  diagnostic,
  isDiagnosticCode,
  isErrorCode,
  isWarningCode,
} from "../src/errors.js";

/**
 * Codes the Technical Design §4.4 pins down. The registry may grow, but none of
 * these may disappear or change meaning inside a major version.
 */
const REQUIRED_CODES = [
  "E_DAEMON_UNREACHABLE",
  "E_VERSION_MISMATCH",
  "E_UNSUPPORTED_OS",
  "E_NODE_TOO_OLD",
  "E_PASEO_CLI_MISSING",
  "E_PASEO_OUTPUT_UNEXPECTED",
  "E_CONFLICT",
  "E_BAD_SKILLS_AGENTS",
  "E_BAD_ROLE_SPEC",
  "E_CONFIG_CONCURRENT_WRITE",
  "E_RECORD_SCHEMA_TOO_NEW",
  "E_LOCKED",
  "E_PROVIDER_UNAVAILABLE",
  // Added by the 2026-09-15 errata to Design §4.3/§4.4.
  "E_UNSAFE_INSTALL_HOME",
  "E_PATH_ESCAPE",
  "E_SYMLINK_IN_PATH",
  "E_TARGET_NOT_WRITABLE",
  "E_PLUGIN_LOAD_FAILED",
  "W_SKILLS_MISSING",
  "W_BEADS_CLI_MISSING",
  "W_SKILLS_ASSIST_FAILED",
  "W_PROVIDER_NOT_LOGGED_IN",
  // Setup screen delta, 2026-09-16.
  "W_BEADS_TOOLS_INSTALL_FAILED",
  "W_BEADS_VIEWER_MISSING",
] as const;

const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

/** The registry itself is where codes are allowed to be written out in full. */
const REGISTRY_FILE = "errors.ts";

/**
 * Identifiers that look like a diagnostic code but are not one. `W_OK`, `R_OK`,
 * `X_OK` and `F_OK` are Node's `fs.constants` access-mode flags.
 */
const NOT_DIAGNOSTIC_CODES = new Set(["W_OK", "R_OK", "X_OK", "F_OK"]);

const CODE_MENTION = /\b[EW]_[A-Z0-9]+(?:_[A-Z0-9]+)*\b/g;

interface CodeMention {
  readonly file: string;
  readonly line: number;
  readonly code: string;
}

function listTypeScriptFiles(dir: string): string[] {
  const found: string[] = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      found.push(...listTypeScriptFiles(full));
    } else if (item.isFile() && item.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found.sort();
}

/**
 * Finds every diagnostic-code-shaped literal under `dir`, skipping the registry
 * itself. Returns mentions whose code is not registered — i.e. codes that were
 * invented in place, which the design forbids.
 */
function findUnregisteredCodes(dir: string, skipFiles: readonly string[] = [REGISTRY_FILE]): CodeMention[] {
  const unregistered: CodeMention[] = [];
  for (const file of listTypeScriptFiles(dir)) {
    const relativePath = relative(dir, file).split(sep).join("/");
    if (skipFiles.includes(relativePath)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(CODE_MENTION)) {
        const code = match[0];
        if (NOT_DIAGNOSTIC_CODES.has(code)) continue;
        if (isDiagnosticCode(code)) continue;
        unregistered.push({ file: relativePath, line: index + 1, code });
      }
    }
  }
  return unregistered;
}

function describeMentions(mentions: readonly CodeMention[]): string {
  return mentions.map((m) => `${m.file}:${m.line} ${m.code}`).join(", ");
}

describe("diagnostic registry", () => {
  it("registers every code the Technical Design §4.4 pins down", () => {
    for (const code of REQUIRED_CODES) {
      expect(isDiagnosticCode(code), `missing code ${code}`).toBe(true);
    }
  });

  it("gives every entry a non-empty message and remediation", () => {
    for (const [key, entry] of Object.entries(DIAGNOSTICS)) {
      expect(entry.message.trim(), `${key}.message`).not.toBe("");
      expect(entry.remediation.trim(), `${key}.remediation`).not.toBe("");
      expect(entry.remediation.trim(), `${key}.remediation duplicates the message`).not.toBe(entry.message.trim());
    }
  });

  it("keys the registry by the code itself, in the documented shape", () => {
    for (const [key, entry] of Object.entries(DIAGNOSTICS)) {
      expect(entry.code, `${key} is registered under a different code`).toBe(key);
      expect(key).toMatch(DIAGNOSTIC_CODE_PATTERN);
      expect(key.startsWith("E_") || key.startsWith("W_"), `${key} has no E_/W_ prefix`).toBe(true);
    }
    expect(new Set(DIAGNOSTIC_CODES).size).toBe(DIAGNOSTIC_CODES.length);
  });

  it("classifies codes by prefix and rejects unknown ones", () => {
    expect(isErrorCode("E_LOCKED")).toBe(true);
    expect(isWarningCode("E_LOCKED")).toBe(false);
    expect(isWarningCode("W_BEADS_CLI_MISSING")).toBe(true);
    expect(isErrorCode("W_BEADS_CLI_MISSING")).toBe(false);
    expect(isDiagnosticCode("E_DAEMON_DOWN")).toBe(false);
    expect(isErrorCode("E_DAEMON_DOWN")).toBe(false);
    expect(diagnostic("E_LOCKED").code).toBe("E_LOCKED");
  });
});

describe("source scan", () => {
  const fixtures: string[] = [];

  function fixtureDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "paseo-bm-scan-"));
    fixtures.push(dir);
    for (const [name, content] of Object.entries(files)) {
      const full = join(dir, name);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf8");
    }
    return dir;
  }

  afterAll(() => {
    for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  });

  it("catches a code invented in place", () => {
    const dir = fixtureDir({
      "preflight.ts": 'export const failure = { code: "E_DAEMON_DOWN" };\n',
      "nested/lock.ts": 'throw new Error("W_MADE_UP_WARNING");\n',
    });
    const found = findUnregisteredCodes(dir);
    expect(found.map((m) => m.code).sort()).toEqual(["E_DAEMON_DOWN", "W_MADE_UP_WARNING"]);
    expect(found[0]?.line).toBe(1);
  });

  it("accepts registered codes and ignores fs access-mode constants", () => {
    const dir = fixtureDir({
      "ok.ts": [
        'import { DIAGNOSTICS } from "./errors.js";',
        "export const code = DIAGNOSTICS.E_LOCKED.code;",
        'export const warn = "W_BEADS_CLI_MISSING";',
        "export const mode = constants.W_OK | constants.R_OK;",
      ].join("\n"),
    });
    expect(findUnregisteredCodes(dir)).toEqual([]);
  });

  it("does not scan the registry file itself", () => {
    const dir = fixtureDir({ "errors.ts": 'export const code = "E_NOT_REAL";\n' });
    expect(findUnregisteredCodes(dir)).toEqual([]);
    expect(findUnregisteredCodes(dir, []).map((m) => m.code)).toEqual(["E_NOT_REAL"]);
  });

  it("finds no unregistered code anywhere in src/", () => {
    const found = findUnregisteredCodes(SRC_DIR);
    expect(found, `unregistered diagnostic codes: ${describeMentions(found)}`).toEqual([]);
  });
});
