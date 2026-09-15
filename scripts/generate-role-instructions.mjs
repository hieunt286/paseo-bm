#!/usr/bin/env node
// Generates plugin/server/{manager,worker,reviewer}-instructions.ts from
// plugin/roles/{manager,worker,reviewer}.md.
//
// Paseo 0.8 bundles the server entry as CommonJS and runs it in a forked worker
// without a cwd, so the server code cannot locate files of its own payload at
// run time (`import.meta.url` is empty, `__dirname` / `process.cwd()` point
// elsewhere — bm-dnc). The role instructions are therefore baked into the
// bundle as string constants. `roles/*.md` stay the source of truth and stay in
// the payload; test/plugin-bundle-cjs.test.ts fails when a generated module and
// its markdown differ by a single byte.
//
// Manager instructions are set by `manager.ensure`; all three are also injected
// by the `before("agent.create")` hook, because agents created through Paseo's
// `create_agent` tool get no system prompt at all (bm-hld).
//
// The files are committed so a fresh checkout typechecks and tests; the build
// rewrites them, and `prepack` runs the build, so every tarball carries the
// current text. Idempotent: it only writes when the content changes.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const roles = [
  { role: "manager", constant: "MANAGER" },
  { role: "worker", constant: "WORKER" },
  { role: "reviewer", constant: "REVIEWER" },
];

for (const { role, constant } of roles) {
  const sourceUrl = new URL(`../plugin/roles/${role}.md`, import.meta.url);
  const targetUrl = new URL(`../plugin/server/${role}-instructions.ts`, import.meta.url);

  const text = readFileSync(sourceUrl, "utf8");

  const contents = `// GENERATED FILE — do not edit by hand.
// Regenerated from plugin/roles/${role}.md by scripts/generate-role-instructions.mjs,
// which the build runs before packing. Edit the markdown, then run \`npm run build\`.

/** Name of the embedded instructions, as reported by \`roles.describe\`. */
export const ${constant}_INSTRUCTIONS_NAME = "roles/${role}.md";

/** Exact text of \`roles/${role}.md\`, baked in at build time. */
export const ${constant}_INSTRUCTIONS = ${JSON.stringify(text)};
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
}
