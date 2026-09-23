#!/usr/bin/env node
// Smoke test for the packed npm package (bead bm-wp-101-b51.3, Design §10
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
  check(existsSync(join(packed, "plugin", "paseo-plugin.json")), "tarball contains plugin/paseo-plugin.json");
  // The copy at the tarball root is what the paseo.cafe registry reads: its npm
  // check opens paseo-plugin.json at the root and ignores the entry's `path`.
  // Dropping it from `files` would break the listing with every other check
  // still green. See docs/operations/paseo-bm-cafe-listing-20260923.md §4.
  // The screenshots exist for the paseo.cafe listing, which reads them from the
  // plugin path in git. Nobody running `npx paseo-bm` should download them, so
  // `files` excludes them with a negative pattern — and npm honouring that
  // pattern is exactly the kind of thing to verify on a real tarball rather
  // than trust. See docs/design/paseo-bm-delta-20260923-payload-npm-package.md §6.
  const packedImages = readdirSync(join(packed, "plugin"), { withFileTypes: true }).filter(
    (entry) => entry.name === "images",
  );
  check(packedImages.length === 0, "tarball carries no plugin/images/ directory");

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
  for (const entry of ["index.server.ts", "index.client.tsx", "roles/manager.md", "roles/worker.md", "roles/reviewer.md"]) {
    check(existsSync(join(packed, "plugin", entry)), `tarball contains plugin/${entry}`);
  }
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
  // Every payload file in the repo must ship, with exactly one deliberate
  // exception: plugin/images/ exists for the paseo.cafe listing and is excluded
  // from this tarball by a negative `files` pattern, asserted above. The
  // exception is spelled out here rather than by relaxing the check, so a file
  // that goes missing for any other reason still fails.
  const payloadExcluded = (path) => path === "images" || path.startsWith("images/");
  const repoPayload = snapshot(join(repoRoot, "plugin"));
  const packedPayload = snapshot(join(packed, "plugin"));
  const missing = [...repoPayload.keys()].filter((path) => !packedPayload.has(path) && !payloadExcluded(path));
  check(missing.length === 0, `every file under plugin/ except images/ is in the tarball${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
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
    existsSync(join(installed, "package.json")) && existsSync(join(installed, "plugin", "paseo-plugin.json")),
    "installed layout satisfies findPayloadRoot (package.json + plugin/paseo-plugin.json above dist/)",
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
        "daemon status": { stdout: JSON.stringify({ home: join(fakeHome, ".paseo"), cliVersion: "0.8.0", daemonVersion: "0.8.0" }) },
        "plugin ls": { stdout: "[]" },
        "provider ls": { stdout: JSON.stringify([{ provider: "claude", label: "Claude", status: "available" }]) },
        "provider models": { stdout: JSON.stringify([{ id: "claude-opus-5", model: "Opus 5" }]) },
        "provider diagnostic": { stdout: JSON.stringify({ provider: "claude", diagnostic: 'Auth: {"loggedIn": true}' }) },
      }),
    );
    const flowEnv = { ...cliEnv, BM_FAKE_SCRIPT: scriptFile };
    const ignoredInWork = new Set(["fake-paseo-argv.jsonl"]);
    const workSnapshot = () => new Map([...snapshot(work)].filter(([path]) => !ignoredInWork.has(path)));
    const workBefore = workSnapshot();

    const preview = run(bin, ["install"], { cwd: neutralCwd, env: flowEnv });
    console.log(`$ paseo-bm install -> exit ${preview.status}`);
    if (preview.status !== 6) console.log(`  stdout: ${preview.stdout}\n  stderr: ${preview.stderr}`);
    check(preview.status === 6, "paseo-bm install without a TTY and without --apply exits 6");
    check(preview.stdout.includes("Planned changes"), "paseo-bm install prints the preview");

    const previewJson = run(bin, ["install", "--json"], { cwd: neutralCwd, env: flowEnv });
    let previewReport;
    try {
      previewReport = JSON.parse(previewJson.stdout);
    } catch {
      previewReport = undefined;
    }
    console.log(`$ paseo-bm install --json -> exit ${previewJson.status}`);
    check(
      previewJson.status === 6 && previewReport?.mode === "preview" && previewReport?.result?.exitCode === 6,
      "paseo-bm install --json prints one preview document with result.exitCode 6",
    );

    const doctor = run(bin, ["doctor", "--json"], { cwd: neutralCwd, env: flowEnv });
    let doctorReport;
    try {
      doctorReport = JSON.parse(doctor.stdout);
    } catch {
      doctorReport = undefined;
    }
    console.log(`$ paseo-bm doctor --json -> exit ${doctor.status}`);
    if (doctor.status !== 0) console.log(`  stdout: ${doctor.stdout}\n  stderr: ${doctor.stderr}`);
    check(doctor.status === 0 && doctorReport?.result?.exitCode === 0, "paseo-bm doctor on a machine without paseo-bm exits 0");
    check(
      doctorReport?.checks?.some((entry) => entry.id === "install-record" && entry.severity === "warn") === true,
      "paseo-bm doctor reports that paseo-bm is not installed",
    );

    const argvLog = existsSync(fakeLog) ? readFileSync(fakeLog, "utf8") : "";
    check(argvLog.includes('"daemon","status"'), "install and doctor talked to the fake paseo, not a real one");
    check(!existsSync(join(fakeHome, ".paseo-bm")), "the install preview created no install home");
    check(sameSnapshot(workBefore, workSnapshot()), "install preview and doctor wrote nothing, inside the fake HOME or anywhere else in the work dir");
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
