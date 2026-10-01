#!/usr/bin/env node
// Generates plugin-package/, the published form of the plugin (ADR-026), from
// plugin/, the source.
//
// paseo.cafe's security scan reads the listed plugin's executable graph, both
// in Git (the registry entry's `path`) and in the npm tarball, and refuses one
// over 200 files or 2,000,000 bytes (`scripts/plugin-security/static-scan.ts`
// in paseo-cafe/paseo-cafe). plugin/ is 250 files and about 3.5 MB of
// TypeScript, so the listing points at plugin-package/ instead, and npm
// publishes it: the two entries, each bundled into one file by esbuild, with
// the manifest, package.json, README.md and LICENSE.
//
// The bundles keep every module outside Paseo's host-provided set inside them,
// and leave the host-provided set as imports (the same set the scan accepts):
// the SDK, zod, react, react-native, @tanstack/react-query and Node built-ins.
// Whitespace and syntax are minified, identifiers are not, so a stack trace
// still names the function. Paseo compiles these files as it compiled the
// sources: it re-bundles each entry with esbuild.
//
// The listing's images are copied from plugin/images/ (the npm tarball does not
// carry them). Every file in plugin-package/ is written here, and nothing else
// is kept there. The files are committed, because the listing reads Git; a test
// fails when they differ from a fresh run (test/plugin-package.test.ts).
// Idempotent: a file is written only when its content changes.
//
// Usage: node scripts/generate-plugin-package.mjs [--check]
//   --check  write nothing; exit 1 and name each file that would change.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const source = join(repoRoot, "plugin");
const target = join(repoRoot, "plugin-package");

/** paseo.cafe's scan limits on the reachable graph, as of paseo-cafe 4608732. */
export const SCAN_MAX_BYTES = 2_000_000;
export const SCAN_MAX_FILES = 200;

/** Modules Paseo provides to a plugin at run time; never bundled. */
export const HOST_PROVIDED = [
  "@getpaseo/*",
  "zod",
  "zod/*",
  "react",
  "react/*",
  "react-native",
  "react-native/*",
  "@tanstack/react-query",
  "node:*",
];

const ENTRIES = [
  { file: "index.server.ts", platform: "node" },
  { file: "index.client.tsx", platform: "neutral" },
];

// esbuild is not a direct dependency of this repository: it is resolved
// through tsup, which pins it, so the build uses the same esbuild every time.
const esbuild = createRequire(createRequire(join(repoRoot, "package.json")).resolve("tsup"))("esbuild");

function header(file, version) {
  return `// @ts-nocheck
// GENERATED FILE — do not edit. paseo-bm-plugin ${version}: plugin/${file} and
// everything it imports, bundled by scripts/generate-plugin-package.mjs
// (\`npm run build\`). Read the source at
// https://github.com/hieunt286/paseo-bm/tree/v${version}/plugin (ADR-026).
`;
}

async function bundle(file, platform, version) {
  const result = await esbuild.build({
    entryPoints: [join(source, file)],
    bundle: true,
    write: false,
    format: "esm",
    platform,
    target: "es2022",
    jsx: "automatic",
    external: HOST_PROVIDED,
    legalComments: "none",
    charset: "utf8",
    minifyWhitespace: true,
    minifySyntax: true,
    logLevel: "silent",
  });
  if (result.outputFiles.length !== 1) throw new Error(`${file}: expected one output file`);
  return `${header(file, version)}${result.outputFiles[0].text}`;
}

/** The published package.json: plugin/package.json with the published file list. */
function packageJson() {
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const out = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (key === "scripts") continue;
    if (key === "repository") out.repository = { ...value, directory: "plugin-package" };
    else if (key === "files") out.files = ["paseo-plugin.json", "index.client.tsx", "index.server.ts", "LICENSE", "README.md"];
    else out[key] = value;
  }
  return { version: manifest.version, text: `${JSON.stringify(out, null, 2)}\n` };
}

/** Every file of plugin-package/, path → content. */
export async function generatedFiles() {
  const pkg = packageJson();
  const files = new Map();
  for (const { file, platform } of ENTRIES) files.set(file, Buffer.from(await bundle(file, platform, pkg.version)));
  files.set("package.json", Buffer.from(pkg.text));
  for (const copied of ["paseo-plugin.json", "README.md", "LICENSE"]) {
    files.set(copied, readFileSync(join(source, copied)));
  }
  for (const image of readdirSync(join(source, "images")).filter((name) => !name.startsWith("."))) {
    files.set(`images/${image}`, readFileSync(join(source, "images", image)));
  }
  return files;
}

/** Every file under `dir`, as POSIX paths relative to it; [] when it does not exist. */
export function listFiles(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

async function main() {
  const check = process.argv.includes("--check");
  const files = await generatedFiles();
  const code = ENTRIES.reduce((sum, { file }) => sum + files.get(file).length, 0);
  if (code > SCAN_MAX_BYTES) {
    throw new Error(`the bundled entries are ${code} bytes, over paseo.cafe's scan limit of ${SCAN_MAX_BYTES}`);
  }
  const stale = [];
  for (const [name, content] of files) {
    const path = join(target, name);
    if (existsSync(path) && readFileSync(path).equals(content)) continue;
    stale.push(name);
    if (!check) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
      console.log(`generated plugin-package/${name}`);
    }
  }
  // A file left from an earlier run (a renamed image, say) would be published or listed.
  const extra = listFiles(target).filter((name) => !files.has(name));
  if (extra.length > 0) {
    console.error(`plugin-package/ holds files the build does not write; delete them: ${extra.join(", ")}`);
    process.exit(1);
  }
  if (check && stale.length > 0) {
    console.error(`plugin-package/ is out of date (run \`npm run build\`): ${stale.join(", ")}`);
    process.exit(1);
  }
  console.log(`plugin-package: entries ${code} bytes of ${SCAN_MAX_BYTES}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
