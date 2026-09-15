import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readVersion } from "../src/version.js";

describe("readVersion", () => {
  it("returns the version declared in package.json", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(readVersion()).toBe(manifest.version);
  });

  it("returns a non-empty string", () => {
    expect(readVersion()).toMatch(/\S/);
  });
});
