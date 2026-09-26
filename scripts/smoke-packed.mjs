#!/usr/bin/env node
// Smoke test for the packed npm package (bead bm-wp-101-b51.3, Technical Design §11
// "Gói đã đóng").
//
// Everything here runs against the real tarball produced by `npm pack`, never
// against the source tree: the failure this guards against is a file that works
// in the repo but was left out of the `files` field, which only shows up when a
// user runs `npx paseo-bm`.
//
// Steps:
//   1. `npm pack` into an empty temp directory (this runs `prepack`, i.e. the
//      real build, exactly as a publish would).
//   2. Extract the tarball and assert its contents: dist/index.js, the plugin/
//      payload, and no install lifecycle scripts in the packed package.json.
//   3. Install the tarball into an isolated temp project, offline, with a
//      throwaway npm cache and userconfig (the package has no runtime
//      dependencies, so nothing needs the network).
//   4. Run the installed `paseo-bm` bin with a fake HOME and a PATH that holds
//      only a fake `paseo` plus the node binary; assert `--version` prints the
//      package version and `--help` exits 0 with usage text.
//   5. Assert the run wrote nothing into the installed package or the working
//      directory, and that the installed layout satisfies findPayloadRoot
//      (package.json and plugin/paseo-plugin.json side by side above dist/).
//
// Flags: --keep  leave the temp directory in place for inspection.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const fakeHome = join(work, "home");
const fakeBin = join(work, "bin");
const neutralCwd = join(work, "cwd");
for (const dir of [packDir, extractDir, projectDir, npmCache, fakeHome, fakeBin, neutralCwd]) {
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
  const sourceManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const expectedVersion = sourceManifest.version;
  console.log(`paseo-bm smoke (packed) — expecting version ${expectedVersion}`);
  console.log(`work dir: ${work}`);

  // 1. Pack. prepack output goes to stderr so the tarball name is the only thing we need.
  console.log("\n# npm pack");
  const pack = run("npm", ["pack", "--pack-destination", packDir], {
    cwd: repoRoot,
    env: npmEnv,
    stdio: ["ignore", "pipe", "inherit"],
  });
  process.stdout.write(pack.stdout);
  if (pack.status !== 0) throw new Error(`npm pack failed with exit code ${pack.status}`);
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`expected exactly one tarball, found: ${tarballs.join(", ") || "none"}`);
  const tarball = join(packDir, tarballs[0]);

  // 2. Inspect the tarball itself, independently of what npm reported.
  console.log("\n# tarball contents");
  mustRun("tar extract", "tar", ["-xzf", tarball, "-C", extractDir]);
  const packed = join(extractDir, "package");
  const packedManifest = JSON.parse(readFileSync(join(packed, "package.json"), "utf8"));
  check(packedManifest.version === expectedVersion, `packed package.json version is ${expectedVersion}`);
  check(existsSync(join(packed, "dist", "index.js")), "tarball contains dist/index.js");
  // From 0.4.0 this tarball is the migration command and nothing else: the
  // payload ships as `paseo-bm-plugin`, checked below, and carrying a second
  // copy here would mean two sources of the same plugin on one machine
  // (ADR-012 decision 1).
  check(!existsSync(join(packed, "plugin")), "installer tarball carries no plugin/ directory");
  const packedTop = readdirSync(packed, { withFileTypes: true }).map((entry) => entry.name).sort();
  check(
    packedTop.every((name) => ["dist", "package.json", "README.md", "LICENSE"].includes(name)),
    `installer tarball root has only dist/, package.json, README.md and LICENSE (found: ${packedTop.join(", ")})`,
  );

  // 2b. The payload is published as its own package, paseo-bm-plugin, whose
  // tarball root must BE a loadable plugin: that is what the paseo.cafe
  // security scan checks, and it always reads the tarball root (ADR-009).
  console.log("\n# payload package (paseo-bm-plugin)");
  const payloadPackDir = join(work, "payload-pack");
  const payloadExtractDir = join(work, "payload-extract");
  mkdirSync(payloadPackDir, { recursive: true });
  mkdirSync(payloadExtractDir, { recursive: true });
  const payloadPack = run("npm", ["pack", "--pack-destination", payloadPackDir], {
    cwd: join(repoRoot, "plugin"),
    env: npmEnv,
    stdio: ["ignore", "pipe", "inherit"],
  });
  process.stdout.write(payloadPack.stdout);
  if (payloadPack.status !== 0) throw new Error(`npm pack (payload) failed with exit code ${payloadPack.status}`);
  const payloadTarballs = readdirSync(payloadPackDir).filter((name) => name.endsWith(".tgz"));
  if (payloadTarballs.length !== 1) {
    throw new Error(`expected exactly one payload tarball, found: ${payloadTarballs.join(", ") || "none"}`);
  }
  mustRun("tar extract (payload)", "tar", ["-xzf", join(payloadPackDir, payloadTarballs[0]), "-C", payloadExtractDir]);
  const payloadPacked = join(payloadExtractDir, "package");
  const payloadManifest = JSON.parse(readFileSync(join(payloadPacked, "package.json"), "utf8"));
  check(payloadManifest.name === "paseo-bm-plugin", "payload package is named paseo-bm-plugin");
  check(payloadManifest.version === expectedVersion, `payload package version is ${expectedVersion}`);
  for (const entry of ["paseo-plugin.json", "index.client.tsx", "index.server.ts", "LICENSE", "README.md"]) {
    check(existsSync(join(payloadPacked, entry)), `payload tarball root has ${entry}`);
  }
  // The manifest a daemon reads out of the tarball is what decides whether it
  // loads at all; 0.8 has no npm plugin source, so it must refuse (ADR-012 D2).
  const payloadPluginManifest = JSON.parse(readFileSync(join(payloadPacked, "paseo-plugin.json"), "utf8"));
  check(
    payloadPluginManifest.requirements?.paseo === ">=0.9.0",
    'payload manifest requires Paseo ">=0.9.0"',
  );
  check(
    !existsSync(join(payloadPacked, "images")),
    "payload tarball carries no images/ directory",
  );
  // The payload's `files` is a hand-written allowlist, so a new directory under
  // plugin/ would silently not ship — and an npm version cannot be republished.
  // Hold it to the same standard as the installer: everything in plugin/ ships,
  // except the screenshots and the files npm never packs.
  const payloadExcludedFromTarball = (path) =>
    path === "images" ||
    path.startsWith("images/") ||
    path === "package.json" ||
    path === ".DS_Store";
  const repoPayloadFiles = snapshot(join(repoRoot, "plugin"));
  const packedPayloadFiles = snapshot(payloadPacked);
  const missingFromPayload = [...repoPayloadFiles.keys()].filter(
    (path) => !packedPayloadFiles.has(path) && !payloadExcludedFromTarball(path),
  );
  check(
    missingFromPayload.length === 0,
    `every file under plugin/ except images/ is in the payload tarball${missingFromPayload.length ? ` (missing: ${missingFromPayload.join(", ")})` : ""}`,
  );

  // The installer tarball root must NOT look like a plugin: the payload package
  // is the one whose root is loadable. A manifest here would make
  // `paseo plugin add npm:paseo-bm@<v>` find a plugin with no runtime entry.
  check(
    !existsSync(join(packed, "paseo-plugin.json")),
    "installer tarball root carries no paseo-plugin.json",
  );
  // Every built file must ship. Checking only the bin is not enough: npm always
  // packs the `bin` target even when dist/ is missing from `files`, so a
  // bin-only check stays green while chunks and sourcemaps are silently dropped.
  const repoDist = snapshot(join(repoRoot, "dist"));
  const packedDist = snapshot(join(packed, "dist"));
  const missingDist = [...repoDist.keys()].filter((path) => !packedDist.has(path));
  check(
    repoDist.size > 0 && missingDist.length === 0,
    `every built file under dist/ is in the tarball${missingDist.length ? ` (missing: ${missingDist.join(", ")})` : ""}`,
  );
  const lifecycle = ["preinstall", "install", "postinstall", "prepare"].filter(
    (name) => name in (packedManifest.scripts ?? {}),
  );
  check(lifecycle.length === 0, `packed package.json has no install lifecycle scripts${lifecycle.length ? ` (found: ${lifecycle.join(", ")})` : ""}`);
  check(
    Object.keys(packedManifest.dependencies ?? {}).length === 0,
    "packed package.json has no runtime dependencies (offline install possible)",
  );

  // 3. Install the tarball into an isolated project, offline.
  console.log("\n# npm install <tarball> (offline, isolated cache)");
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "smoke-project", private: true }, null, 2));
  mustRun("npm install", "npm", ["install", "--offline", "--no-save", "--no-package-lock", tarball], {
    cwd: projectDir,
    env: npmEnv,
  });
  const installed = join(projectDir, "node_modules", "paseo-bm");
  const bin = join(projectDir, "node_modules", ".bin", "paseo-bm");
  check(existsSync(bin), "installed package exposes node_modules/.bin/paseo-bm");
  check(
    existsSync(join(installed, "package.json")) && existsSync(join(installed, "dist", "index.js")),
    "installed layout is the command and nothing else (package.json + dist/)",
  );

  // 4. Run the installed bin with a fake HOME and a PATH holding only a fake paseo and node.
  console.log("\n# run installed paseo-bm");
  const fakePaseo = join(fakeBin, "paseo");
  copyFileSync(join(repoRoot, "test", "fakes", "paseo"), fakePaseo);
  chmodSync(fakePaseo, 0o755);
  const fakeLog = join(work, "fake-paseo-argv.jsonl");
  const cliEnv = {
    HOME: fakeHome,
    PATH: [fakeBin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    BM_FAKE_ARGV_LOG: fakeLog,
    NO_COLOR: "1",
  };
  const installedBefore = snapshot(installed);
  const cwdBefore = snapshot(neutralCwd);

  if (existsSync(bin)) {
    const version = run(bin, ["--version"], { cwd: neutralCwd, env: cliEnv });
    console.log(`$ paseo-bm --version -> exit ${version.status}, stdout ${JSON.stringify(version.stdout)}`);
    if (version.stderr) console.log(`  stderr: ${version.stderr}`);
    check(version.status === 0, "paseo-bm --version exits 0");
    check(version.stdout.trim() === expectedVersion, `paseo-bm --version prints ${expectedVersion}`);

    const help = run(bin, ["--help"], { cwd: neutralCwd, env: cliEnv });
    console.log(`$ paseo-bm --help -> exit ${help.status}`);
    if (help.stderr) console.log(`  stderr: ${help.stderr}`);
    check(help.status === 0, "paseo-bm --help exits 0");
    check(/usage/i.test(help.stdout) && help.stdout.includes("paseo-bm"), "paseo-bm --help prints usage text");

    // Install preview and doctor from the packed package (carry-over from
    // bm-wp-101-b51.3, bead bm-wp-105-6ec.5). stdin/stdout are pipes, so there
    // is no TTY. Exit codes come from Design §4.3 (src/exit-codes.ts):
    //   install, no TTY and no --apply -> 6 (preview printed, nothing written);
    //   doctor where paseo-bm is not installed -> 0 (nothing owned can deviate;
    //   "not installed" is a warning, and warnings never change the exit code).
    const scriptFile = join(work, "fake-paseo-script.json");
    writeFileSync(
      scriptFile,
      JSON.stringify({
        "daemon status": { stdout: JSON.stringify({ home: join(fakeHome, ".paseo"), cliVersion: "0.9.2", daemonVersion: "0.9.2" }) },
        "plugin ls": { stdout: "[]" },
      }),
    );
    const flowEnv = { ...cliEnv, BM_FAKE_SCRIPT: scriptFile };
    const ignoredInWork = new Set(["fake-paseo-argv.jsonl"]);
    const workSnapshot = () => new Map([...snapshot(work)].filter(([path]) => !ignoredInWork.has(path)));
    const workBefore = workSnapshot();

    // Nothing of paseo-bm on this machine: the one supported answer is the
    // paseo.cafe instructions, exit 0, and no write anywhere (case D, §4.3).
    const bare = run(bin, [], { cwd: neutralCwd, env: flowEnv });
    console.log(`$ paseo-bm -> exit ${bare.status}`);
    if (bare.status !== 0) console.log(`  stdout: ${bare.stdout}\n  stderr: ${bare.stderr}`);
    check(bare.status === 0, "paseo-bm on a machine with no paseo-bm plugin exits 0");
    check(
      bare.stdout.includes("paseo plugin add npm:paseo-bm-plugin"),
      "paseo-bm prints how to install the plugin instead",
    );

    const bareJson = run(bin, ["--json"], { cwd: neutralCwd, env: flowEnv });
    let bareReport;
    try {
      bareReport = JSON.parse(bareJson.stdout);
    } catch {
      bareReport = undefined;
    }
    console.log(`$ paseo-bm --json -> exit ${bareJson.status}`);
    check(
      bareJson.status === 0 && bareReport?.command === "migrate" && bareReport?.migration?.outcome === "no-directory-install",
      "paseo-bm --json prints one migrate document naming the outcome",
    );

    // The retired commands still explain themselves, and run nothing.
    for (const retired of ["doctor", "uninstall"]) {
      const answer = run(bin, [retired], { cwd: neutralCwd, env: flowEnv });
      console.log(`$ paseo-bm ${retired} -> exit ${answer.status}`);
      check(answer.status === 2, `paseo-bm ${retired} exits 2`);
      check(answer.stderr.includes("E_COMMAND_RETIRED"), `paseo-bm ${retired} says it was retired`);
    }

    const argvLog = existsSync(fakeLog) ? readFileSync(fakeLog, "utf8") : "";
    check(argvLog.includes('"daemon","status"'), "the run talked to the fake paseo, not a real one");
    check(!existsSync(join(fakeHome, ".paseo-bm")), "the run created no data folder");
    check(sameSnapshot(workBefore, workSnapshot()), "the run wrote nothing, inside the fake HOME or anywhere else in the work dir");
  }

  // 5. No stray writes.
  check(sameSnapshot(installedBefore, snapshot(installed)), "running the bin did not modify the installed package");
  check(sameSnapshot(cwdBefore, snapshot(neutralCwd)), "running the bin did not write into the working directory");
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
