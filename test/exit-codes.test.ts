import { describe, expect, it } from "vitest";
import {
  EXIT_CODES,
  EXIT_CODE_SPECS,
  exitCodeMeaning,
  isExitCode,
  previewExitCode,
} from "../src/exit-codes.js";
import { EXIT_CODES as EXIT_CODES_VIA_FLAGS } from "../src/flags.js";

/** Transcribed from Technical Design §4.3. A change here is a contract change. */
const DESIGN_EXIT_TABLE: readonly (readonly [number, string])[] = [
  [0, "ok"],
  [1, "doctorDrift"],
  [2, "usage"],
  [3, "preflight"],
  [4, "consentMissing"],
  [5, "conflict"],
  [6, "noTtyNoApply"],
  [7, "pluginLoadFailed"],
];

describe("exit-code table", () => {
  it("matches Design §4.3 row for row", () => {
    expect(EXIT_CODE_SPECS.map((spec) => [spec.code, spec.name])).toEqual(
      DESIGN_EXIT_TABLE.map(([code, name]) => [code, name]),
    );
    for (const [code, name] of DESIGN_EXIT_TABLE) {
      expect(EXIT_CODES[name as keyof typeof EXIT_CODES]).toBe(code);
    }
  });

  it("is the single source of truth: flags.ts re-exports the same object", () => {
    expect(EXIT_CODES_VIA_FLAGS).toBe(EXIT_CODES);
  });

  it("gives every code a one-line meaning", () => {
    for (const spec of EXIT_CODE_SPECS) {
      expect(exitCodeMeaning(spec.code), spec.name).toBe(spec.meaning);
      expect(spec.meaning.trim()).not.toBe("");
    }
  });

  it("recognises only the eight codes", () => {
    for (const [code] of DESIGN_EXIT_TABLE) {
      expect(isExitCode(code), String(code)).toBe(true);
    }
    expect(isExitCode(8)).toBe(false);
    expect(isExitCode(-1)).toBe(false);
  });
});

describe("previewExitCode", () => {
  it("returns 0 for a preview the user asked for from a terminal", () => {
    expect(previewExitCode({ interactive: true, apply: false })).toBe(EXIT_CODES.ok);
  });

  it("returns 6 when a script forgot --apply, so nothing reads as success", () => {
    const code = previewExitCode({ interactive: false, apply: false });
    expect(code).toBe(EXIT_CODES.noTtyNoApply);
    expect(code).not.toBe(EXIT_CODES.ok);
  });

  it("returns 0 when --apply was given, even without a terminal", () => {
    expect(previewExitCode({ interactive: false, apply: true })).toBe(EXIT_CODES.ok);
    expect(previewExitCode({ interactive: true, apply: true })).toBe(EXIT_CODES.ok);
  });
});
