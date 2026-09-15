#!/usr/bin/env node
// Generates plugin/server/manager-instructions.ts from plugin/roles/manager.md.
//
// Paseo 0.8 bundles the server entry as CommonJS and runs it in a forked worker
// without a cwd, so the server code cannot locate files of its own payload at
// run time (`import.meta.url` is empty, `__dirname` / `process.cwd()` point
// elsewhere — bm-dnc). The Manager instructions are therefore baked into the
// bundle as a string constant. `roles/manager.md` stays the source of truth and
// stays in the payload; test/plugin-bundle-cjs.test.ts fails when the generated
// module and the markdown differ by a single byte.
//
// The file is committed so a fresh checkout typechecks and tests; the build
// rewrites it, and `prepack` runs the build, so every tarball carries the
// current text. Idempotent: it only writes when the content changes.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sourceUrl = new URL("../plugin/roles/manager.md", import.meta.url);
const targetUrl = new URL("../plugin/server/manager-instructions.ts", import.meta.url);

const text = readFileSync(sourceUrl, "utf8");

const contents = `// GENERATED FILE — do not edit by hand.
// Regenerated from plugin/roles/manager.md by scripts/generate-role-instructions.mjs,
// which the build runs before packing. Edit the markdown, then run \`npm run build\`.

/** Name of the embedded instructions, as reported by \`roles.describe\`. */
export const MANAGER_INSTRUCTIONS_NAME = "roles/manager.md";

/** Exact text of \`roles/manager.md\`, baked in at build time. */
export const MANAGER_INSTRUCTIONS = ${JSON.stringify(text)};
`;

let current = "";
try {
  current = readFileSync(targetUrl, "utf8");
} catch {
  current = "";
}

if (current !== contents) {
  writeFileSync(targetUrl, contents);
  console.log(`generated ${fileURLToPath(targetUrl)}`);
}
