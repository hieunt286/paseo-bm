#!/usr/bin/env node
// Generates plugin/shared/version.ts from the package version.
//
// The payload needs its version as a build-time constant because the client
// entry cannot read the file system (docs/design/paseo-bm.md §2.4). The file is
// committed with a dev placeholder so a fresh checkout typechecks; the build
// rewrites it, and `prepack` runs the build, so every published tarball carries
// the real version.
//
// Idempotent: it only writes when the content changes.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageUrl = new URL("../package.json", import.meta.url);
const targetUrl = new URL("../plugin/shared/version.ts", import.meta.url);

const { version } = JSON.parse(readFileSync(packageUrl, "utf8"));
if (typeof version !== "string" || version.length === 0) {
  throw new Error('package.json is missing a usable "version" field');
}

const contents = `// GENERATED FILE — do not edit by hand.
// Regenerated from the package version by scripts/generate-plugin-version.mjs,
// which the build runs before packing. Design ref: docs/design/paseo-bm.md §2.4.

/** Version of the paseo-bm payload, baked in at build time. */
export const PLUGIN_VERSION = ${JSON.stringify(version)};
`;

let current = "";
try {
  current = readFileSync(targetUrl, "utf8");
} catch {
  current = "";
}

if (current !== contents) {
  writeFileSync(targetUrl, contents);
  console.log(`generated ${fileURLToPath(targetUrl)} (${version})`);
}
