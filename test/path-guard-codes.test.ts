import { describe, expect, it } from "vitest";
import { isErrorCode } from "../src/errors.js";
import { pathGuardErrorCode } from "../src/paths-guard.js";
import type { PathGuardReason } from "../src/paths-guard.js";

describe("pathGuardErrorCode (Design §4.4 errata 2026-09-15)", () => {
  const table: readonly (readonly [PathGuardReason, string])[] = [
    ["empty-path", "E_UNSAFE_INSTALL_HOME"],
    ["unsafe-install-home", "E_UNSAFE_INSTALL_HOME"],
    ["outside-root", "E_PATH_ESCAPE"],
    ["symlink-in-path", "E_SYMLINK_IN_PATH"],
  ];

  it.each(table)("maps %s to %s, a registered error code", (reason, code) => {
    expect(pathGuardErrorCode(reason)).toBe(code);
    expect(isErrorCode(code)).toBe(true);
  });
});
