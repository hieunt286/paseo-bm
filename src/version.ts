import { createRequire } from "node:module";

interface PackageManifest {
  version?: unknown;
}

/**
 * Version of the running paseo-bm package.
 *
 * Read at runtime from package.json rather than injected at build time, so the
 * value is identical whether the code runs from `src/` under vitest or from the
 * bundled `dist/index.js` inside an installed package.
 */
export function readVersion(): string {
  const require = createRequire(import.meta.url);
  const manifest = require("../package.json") as PackageManifest;
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("package.json is missing a usable \"version\" field");
  }
  return manifest.version;
}
