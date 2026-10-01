#!/usr/bin/env node
// Smoke test for the one published npm package, paseo-bm-plugin (Technical
// Design §11, the packed-package layer; ADR-009, ADR-022 decision 1).
//
// Everything here runs against the real tarball `npm pack` makes from plugin/,
// never against the source tree: the failure this guards against is a file that
// works in the repo but is missing from plugin/package.json's hand-written
// `files` allowlist, which only shows once the version is on npm — and a
// version on npm cannot be republished.
//
// It packs plugin/ as it is, exactly as release.yml's publish step does (the
// payload has no `prepack`). After a version change, run `npm run build` first,
// as release.yml does; otherwise the version checks below fail.
//
// Steps:
//   1. The root package.json is private and declares nothing a publish would
//      use (no `bin`, `files` or `prepack`): the repository ships one package.
//   2. `npm pack` plugin/ into an empty temp directory.
//   3. Extract the tarball and assert its contents: its root is a loadable
//      plugin (manifest requiring Paseo >=0.9.0, both entries, LICENSE,
//      README.md); every file under plugin/ except images/ ships; the version is
//      the root package.json's; no install lifecycle scripts; no dependencies.
//   4. Install the tarball into an isolated temp project, offline, with a
//      throwaway npm cache and userconfig (the package has no dependencies, so
//      nothing needs the network); assert the installed package is the packed
//      plugin and that the install wrote nothing outside node_modules/.
//
// Flags: --keep  leave the temp directory in place for inspection.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const keep = process.argv.includes("--keep");
const failures = [];

function check(condition, message) {
  if (condition) {
    console.log(`ok   ${message}`);
  } else {
    console.log(`FAIL ${message}`);
    failures.push(message);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function mustRun(label, command, args, options = {}) {
  const result = run(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
  return result;
}

/** Map of POSIX-relative path -> sha256 for every file under `root`. */
function snapshot(root) {
  const out = new Map();
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) out.set(rel, createHash("sha256").update(readFileSync(abs)).digest("hex"));
      else out.set(rel, `<${entry.isSymbolicLink() ? "symlink" : "special"}>`);
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}

function sameSnapshot(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

const work = mkdtempSync(join(tmpdir(), "paseo-bm-smoke-"));
const packDir = join(work, "pack");
const extractDir = join(work, "extract");
const projectDir = join(work, "project");
const npmCache = join(work, "npm-cache");
const npmUserconfig = join(work, "npmrc");
for (const dir of [packDir, extractDir, projectDir, npmCache]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(npmUserconfig, "");

const npmEnv = {
  ...process.env,
  npm_config_cache: npmCache,
  npm_config_userconfig: npmUserconfig,
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
};

try {
  const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const expectedVersion = rootManifest.version;
  if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
    throw new Error('package.json is missing a usable "version" field');
  }
  console.log(`paseo-bm-plugin smoke (packed) — expecting version ${expectedVersion}`);
  console.log(`work dir: ${work}`);

  // 1. The repository publishes one package. The root package.json is the
  // version source and the development root, never a package (ADR-022 D1).
  console.log("\n# root package.json");
  check(rootManifest.private === true, 'root package.json is "private": true');
  const publishFields = ["bin", "files"].filter((field) => field in rootManifest);
  check(publishFields.length === 0, `root package.json declares no bin or files${publishFields.length ? ` (found: ${publishFields.join(", ")})` : ""}`);
  check(!("prepack" in (rootManifest.scripts ?? {})), "root package.json has no prepack script");

  // 2. Pack plugin/ the way release.yml publishes it.
  console.log("\n# npm pack plugin/");
  const pack = run("npm", ["pack", "--pack-destination", packDir], {
    cwd: join(repoRoot, "plugin"),
    env: npmEnv,
    stdio: ["ignore", "pipe", "inherit"],
  });
  process.stdout.write(pack.stdout);
  if (pack.status !== 0) throw new Error(`npm pack failed with exit code ${pack.status}`);
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`expected exactly one tarball, found: ${tarballs.join(", ") || "none"}`);
  const tarball = join(packDir, tarballs[0]);

  // 3. Inspect the tarball itself, independently of what npm reported. Its root
  // must BE a loadable plugin: that is what the paseo.cafe security scan
  // checks, and it always reads the tarball root (ADR-009).
  console.log("\n# tarball contents");
  mustRun("tar extract", "tar", ["-xzf", tarball, "-C", extractDir]);
  const packed = join(extractDir, "package");
  const packedManifest = JSON.parse(readFileSync(join(packed, "package.json"), "utf8"));
  check(packedManifest.name === "paseo-bm-plugin", "package is named paseo-bm-plugin");
  check(packedManifest.version === expectedVersion, `package version is ${expectedVersion}`);
  for (const entry of ["paseo-plugin.json", "index.client.tsx", "index.server.ts", "LICENSE", "README.md"]) {
    check(existsSync(join(packed, entry)), `tarball root has ${entry}`);
  }
  // The manifest a daemon reads out of the tarball is what decides whether it
  // loads at all; 0.8 has no npm plugin source, so it must refuse (ADR-012 D2).
  const pluginManifest = JSON.parse(readFileSync(join(packed, "paseo-plugin.json"), "utf8"));
  check(pluginManifest.requirements?.paseo === ">=0.9.0", 'manifest requires Paseo ">=0.9.0"');
  check(!existsSync(join(packed, "images")), "tarball carries no images/ directory");
  // `files` is a hand-written allowlist, so a new directory under plugin/ would
  // silently not ship. Everything in plugin/ ships, except the screenshots and
  // the files npm never packs.
  const excludedFromTarball = (path) =>
    path === "images" || path.startsWith("images/") || path === "package.json" || path === ".DS_Store";
  const repoFiles = snapshot(join(repoRoot, "plugin"));
  const packedFiles = snapshot(packed);
  const missing = [...repoFiles.keys()].filter((path) => !packedFiles.has(path) && !excludedFromTarball(path));
  check(
    missing.length === 0,
    `every file under plugin/ except images/ is in the tarball${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`,
  );
  // Downloading the package must never run code on the installing machine
  // (AGENTS.md, hard packaging rule).
  const lifecycle = ["preinstall", "install", "postinstall", "prepare"].filter(
    (name) => name in (packedManifest.scripts ?? {}),
  );
  check(lifecycle.length === 0, `package.json has no install lifecycle scripts${lifecycle.length ? ` (found: ${lifecycle.join(", ")})` : ""}`);
  check(
    Object.keys(packedManifest.dependencies ?? {}).length === 0,
    "package.json has no runtime dependencies (offline install possible)",
  );

  // 4. Install the tarball into an isolated project, offline.
  console.log("\n# npm install <tarball> (offline, isolated cache)");
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "smoke-project", private: true }, null, 2));
  const outsideNodeModules = () =>
    new Map([...snapshot(projectDir)].filter(([path]) => path !== "node_modules" && !path.startsWith("node_modules/")));
  const projectBefore = outsideNodeModules();
  mustRun("npm install", "npm", ["install", "--offline", "--no-save", "--no-package-lock", tarball], {
    cwd: projectDir,
    env: npmEnv,
  });
  const installed = join(projectDir, "node_modules", "paseo-bm-plugin");
  check(existsSync(join(installed, "paseo-plugin.json")), "installed package has paseo-plugin.json at its root");
  // npm may normalise the installed package.json; every other file must be
  // the packed file, byte for byte.
  const withoutManifest = (files) => new Map([...files].filter(([path]) => path !== "package.json"));
  check(
    sameSnapshot(withoutManifest(packedFiles), withoutManifest(snapshot(installed))),
    "installed package holds exactly the packed files",
  );
  check(sameSnapshot(projectBefore, outsideNodeModules()), "the install wrote nothing outside node_modules/");
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (keep) console.log(`\nkept work dir: ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\nsmoke (packed): ${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nsmoke (packed): all checks passed");
