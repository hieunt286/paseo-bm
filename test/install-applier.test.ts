/**
 * The install applier (bead bm-wp-105-6ec.2).
 *
 * Every scenario runs planner + applier against a fake `$HOME` with the
 * write-scope guard active, and asserts that every write the guard saw landed
 * inside the install home — not merely inside the allowed scope, which would
 * also admit Paseo's `config.json`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { DIR_MODE, FILE_MODE, createFsOps, sha256 } from "../src/fsops.js";
import { createDiskReader } from "../src/ownership.js";
import { isWithinRoot } from "../src/paths-guard.js";
import { readRecord } from "../src/record.js";
import type { ApplyInstallResult } from "../src/commands/install/applier.js";
import {
  applyInstall,
  findPartialPayloadDirs,
  removePartialPayloadDirs,
} from "../src/commands/install/applier.js";
import type { PayloadManifest } from "../src/commands/install/manifest.js";
import { buildPayloadManifest, findPayloadRoot } from "../src/commands/install/manifest.js";
import type { InstallPlan, PlanInstallInput } from "../src/commands/install/planner.js";
import { payloadDestination, planInstall } from "../src/commands/install/planner.js";
import { startWriteScope } from "./helpers/write-scope.js";

const NOW = new Date("2026-09-15T10:15:00.000Z");

let fakeHome: string;
let installHome: string;
let paseoHome: string;

beforeEach(() => {
  // realpath: the guard records canonical paths, so the fake HOME must be canonical too.
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-applier-")));
  installHome = join(fakeHome, ".paseo-bm");
  paseoHome = join(fakeHome, ".paseo");
  mkdirSync(paseoHome, { recursive: true });
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

function payloadFor(version: string): Record<string, string> {
  return {
    "paseo-plugin.json": '{ "id": "paseo-bm", "requirements": { "paseo": ">=0.8.0" } }\n',
    "index.client.tsx": "export default {};\n",
    "index.server.ts": `export const server = "${version}";\n`,
    "shared/version.ts": `export const PLUGIN_VERSION = "${version}";\n`,
    "roles/manager.md": `# Manager ${version}\n`,
    "roles/worker.md": `# Worker ${version}\n`,
    "roles/reviewer.md": `# Reviewer ${version}\n`,
  };
}

/** A package payload on disk, outside the install home. */
function writePackage(version: string, contents: Record<string, string> = payloadFor(version)): string {
  const root = join(fakeHome, "packages", version, "plugin");
  for (const [path, text] of Object.entries(contents)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text);
  }
  return root;
}

interface RunOptions {
  force?: boolean;
  cleanBeforePlan?: boolean;
  switches?: PlanInstallInput["switches"];
  registration?: PlanInstallInput["registration"];
  manifest?: PayloadManifest;
}

interface RunOutcome {
  plan: InstallPlan;
  result: ApplyInstallResult;
  writes: string[];
  cleaned: string[];
}

async function run(version: string, sourceRoot: string, options: RunOptions = {}): Promise<RunOutcome> {
  const payload = options.manifest ?? (await buildPayloadManifest(sourceRoot));
  const record = await readRecord(createFsOps({ root: installHome }));
  const scope = startWriteScope({ installHome, paseoHome, watch: [fakeHome] });
  try {
    const fsops = scope.fsops();
    const cleaned = options.cleanBeforePlan
      ? await removePartialPayloadDirs({ installHome, record, fsops, fs: scope.fs })
      : [];
    const reader = createDiskReader({ fsops, fs: scope.fs });
    const plan = await planInstall({
      installHome,
      version,
      payload: payload.files,
      record,
      reader,
      force: options.force,
      switches: options.switches,
      registration: options.registration,
    });
    const result = await applyInstall({ plan, payload, record, installHome, paseoHome, fsops, fs: scope.fs, now: NOW });
    scope.assertNoViolations();
    const writes = scope.writes.map((write) => write.canonicalPath);
    expect(writes.filter((path) => !isWithinRoot(installHome, path))).toEqual([]);
    return { plan, result, writes, cleaned };
  } finally {
    scope.restore();
  }
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o7777;
}

/** Every regular file under `dir`, POSIX-relative, sorted. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(relative(dir, full).split(sep).join("/"));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** Bytes, mtime and mode of everything under `dir`, including `dir` itself. */
function snapshot(dir: string): Record<string, { hash: string; mtimeMs: number; mode: number }> {
  const out: Record<string, { hash: string; mtimeMs: number; mode: number }> = {};
  const record = (full: string): void => {
    const stats = lstatSync(full);
    out[relative(dir, full) || "."] = {
      hash: stats.isFile() ? sha256(readFileSync(full)) : "directory",
      mtimeMs: stats.mtimeMs,
      mode: stats.mode & 0o7777,
    };
    if (stats.isDirectory()) {
      for (const name of readdirSync(full)) {
        record(join(full, name));
      }
    }
  };
  record(dir);
  return out;
}

async function recordOnDisk() {
  const loaded = await readRecord(createFsOps({ root: installHome }));
  if (loaded === undefined) {
    throw new Error("no install.json on disk");
  }
  return loaded;
}

/** Re-hashes every `files[]` entry from disk. */
function expectRecordMatchesDisk(files: readonly { path: string; sha256: string; mode: number }[]): void {
  for (const file of files) {
    const absolute = join(installHome, file.path);
    expect({ path: file.path, sha256: sha256(readFileSync(absolute)), mode: modeOf(absolute) }).toEqual(file);
  }
}

describe("fresh install", () => {
  it("creates the directory tree with 0700/0600 and a record whose hashes match the disk", async () => {
    const contents = payloadFor("0.1.0");
    const source = writePackage("0.1.0", contents);
    const { plan, result, writes } = await run("0.1.0", source, {
      switches: { pluginsEnabled: null, injectIntoAgents: null },
      registration: { dir: null },
    });

    expect(plan.situation).toBe("fresh");
    expect(writes.length).toBeGreaterThan(0);

    const expectedPaths = Object.keys(contents).map((path) => payloadDestination("0.1.0", path));
    expect(listFiles(installHome)).toEqual(["install.json", ...expectedPaths].sort());

    for (const dir of ["", "plugin", "plugin/0.1.0", "plugin/0.1.0/roles", "plugin/0.1.0/shared"]) {
      expect({ dir, mode: modeOf(join(installHome, dir)) }).toEqual({ dir, mode: DIR_MODE });
    }
    for (const path of listFiles(installHome)) {
      expect({ path, mode: modeOf(join(installHome, path)) }).toEqual({ path, mode: FILE_MODE });
    }

    const onDisk = await recordOnDisk();
    expect(onDisk).toEqual(result.record);
    expect(result.recordWritten).toBe(true);
    expect(onDisk.version).toBe("0.1.0");
    expect(onDisk.paseo.home).toBe(paseoHome);
    expect(onDisk.files.map((file) => file.path).sort()).toEqual([...expectedPaths].sort());
    expectRecordMatchesDisk(onDisk.files);
    for (const [path, text] of Object.entries(contents)) {
      expect(onDisk.files.find((file) => file.path === payloadDestination("0.1.0", path))?.sha256).toBe(sha256(text));
    }
    expect(onDisk.versions).toEqual([
      { version: "0.1.0", dir: "plugin/0.1.0", installedAt: NOW.toISOString(), active: false },
    ]);
    expect(onDisk.backups).toEqual([]);
    expect(result.backup).toBeNull();

    // Config and daemon actions are handed back, not performed.
    expect(result.deferred.map((action) => action.location)).toEqual(["paseo-config", "paseo-config", "paseo-daemon"]);
    expect(existsSync(join(paseoHome, "config.json"))).toBe(false);
  });

  it("builds the manifest from the real plugin/ payload, roles included", async () => {
    const manifest = await buildPayloadManifest(findPayloadRoot());
    const paths = manifest.files.map((file) => file.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual(
      expect.arrayContaining(["paseo-plugin.json", "roles/manager.md", "roles/worker.md", "roles/reviewer.md"]),
    );
    const pluginJson = manifest.files.find((file) => file.path === "paseo-plugin.json");
    expect(pluginJson?.sha256).toBe(sha256(readFileSync(join(manifest.root, "paseo-plugin.json"))));
  });

  it("refuses a payload containing a symlink", async () => {
    const source = writePackage("0.1.0");
    symlinkSync("/etc/hosts", join(source, "roles", "link.md"));
    await expect(buildPayloadManifest(source)).rejects.toMatchObject({ reason: "unsupported-entry" });
  });
});

describe("upgrade", () => {
  it("leaves the old version directory byte- and mtime-identical, and keeps every version in the record", async () => {
    await run("0.1.0", writePackage("0.1.0"));
    const oldDir = join(installHome, "plugin", "0.1.0");
    const before = snapshot(oldDir);
    const firstInstalledAt = (await recordOnDisk()).versions[0]?.installedAt;

    const { plan, result, writes } = await run("0.2.0", writePackage("0.2.0"));

    expect(plan.situation).toBe("upgrade");
    expect(plan.conflicts).toEqual([]);
    expect(snapshot(oldDir)).toEqual(before);
    expect(writes.filter((path) => isWithinRoot(oldDir, path))).toEqual([]);

    const onDisk = await recordOnDisk();
    expect(onDisk.version).toBe("0.2.0");
    expect(onDisk.files.filter((file) => file.path.startsWith("plugin/0.1.0/"))).toHaveLength(7);
    expect(onDisk.files.filter((file) => file.path.startsWith("plugin/0.2.0/"))).toHaveLength(7);
    expectRecordMatchesDisk(onDisk.files);
    expect(onDisk.versions.map((version) => [version.version, version.installedAt])).toEqual([
      ["0.1.0", firstInstalledAt],
      ["0.2.0", NOW.toISOString()],
    ]);
    expect(result.removedPartialDirs).toEqual([]);
  });

  it("running the same version again writes nothing at all", async () => {
    await run("0.2.0", writePackage("0.2.0"));
    const { plan, result, writes } = await run("0.2.0", writePackage("0.2.0"));
    expect(plan.situation).toBe("reinstall");
    expect(writes).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(result.recordWritten).toBe(false);
  });

  it("a downgrade to a version still on disk keeps both versions' files[] entries and finds no conflict", async () => {
    await run("0.1.0", writePackage("0.1.0"));
    await run("0.2.0", writePackage("0.2.0"));
    const { plan } = await run("0.1.0", writePackage("0.1.0"));
    expect(plan.situation).toBe("downgrade");
    expect(plan.conflicts).toEqual([]);
    const onDisk = await recordOnDisk();
    expect(onDisk.version).toBe("0.1.0");
    expect(onDisk.files).toHaveLength(14);
    expect(onDisk.versions.map((version) => version.version)).toEqual(["0.1.0", "0.2.0"]);
  });
});

describe("partial payload directories", () => {
  it("an interrupted upgrade's directory is removed on the next run, which then completes cleanly", async () => {
    await run("0.1.0", writePackage("0.1.0"));
    // Simulate a run of 0.2.0 killed half-way: some files, a temp file, no record update.
    const partial = join(installHome, "plugin", "0.2.0");
    mkdirSync(join(partial, "roles"), { recursive: true });
    writeFileSync(join(partial, "roles", "worker.md"), "# Worker 0.2.0\n");
    writeFileSync(join(partial, ".index.server.ts.1234.abcdef.tmp"), "half");

    const { plan, result, cleaned } = await run("0.2.0", writePackage("0.2.0"), { cleanBeforePlan: true });

    expect(cleaned).toEqual(["plugin/0.2.0"]);
    expect(plan.conflicts).toEqual([]);
    expect(listFiles(partial)).toEqual(Object.keys(payloadFor("0.2.0")).sort());
    expectRecordMatchesDisk(result.record.files);
    expect(existsSync(join(installHome, "plugin", "0.1.0", "roles", "worker.md"))).toBe(true);
  });

  it("the applier removes a partial directory of another version, and nothing recorded", async () => {
    await run("0.1.0", writePackage("0.1.0"));
    mkdirSync(join(installHome, "plugin", "0.3.0-next.1", "roles"), { recursive: true });
    writeFileSync(join(installHome, "plugin", "0.3.0-next.1", "roles", "worker.md"), "partial\n");

    const { result } = await run("0.2.0", writePackage("0.2.0"));

    expect(result.removedPartialDirs).toEqual(["plugin/0.3.0-next.1"]);
    expect(existsSync(join(installHome, "plugin", "0.3.0-next.1"))).toBe(false);
    expect(existsSync(join(installHome, "plugin", "0.1.0"))).toBe(true);
    const fsops = createFsOps({ root: installHome });
    expect(await findPartialPayloadDirs({ installHome, record: await recordOnDisk(), fsops })).toEqual([]);
  });

  it("without a record nothing is provably ours, so nothing is removed", async () => {
    mkdirSync(join(installHome, "plugin", "0.1.0"), { recursive: true });
    const fsops = createFsOps({ root: installHome });
    expect(await findPartialPayloadDirs({ installHome, record: undefined, fsops })).toEqual([]);
  });
});

describe("overwrites and conflicts", () => {
  it("a user-modified file is left alone without --force, and backed up before --force overwrites it", async () => {
    await run("0.1.0", writePackage("0.1.0"));
    const worker = join(installHome, "plugin", "0.1.0", "roles", "worker.md");
    writeFileSync(worker, "# edited by the user\n");

    const kept = await run("0.1.0", writePackage("0.1.0"));
    expect(kept.plan.conflicts).toHaveLength(1);
    expect(kept.result.untouched.map((action) => action.kind)).toContain("conflict");
    expect(readFileSync(worker, "utf8")).toBe("# edited by the user\n");

    const { result } = await run("0.1.0", writePackage("0.1.0"), { force: true });
    expect(result.backup).toEqual({ at: NOW.toISOString(), dir: "backups/20260915T101500Z", reason: "user-modified" });
    const backupCopy = join(installHome, "backups", "20260915T101500Z", "plugin", "0.1.0", "roles", "worker.md");
    expect(readFileSync(backupCopy, "utf8")).toBe("# edited by the user\n");
    expect(modeOf(backupCopy)).toBe(FILE_MODE);
    expect(modeOf(join(installHome, "backups"))).toBe(DIR_MODE);
    expect(readFileSync(worker, "utf8")).toBe("# Worker 0.1.0\n");

    const onDisk = await recordOnDisk();
    expect(onDisk.backups).toEqual([result.backup]);
    expectRecordMatchesDisk(onDisk.files);
  });

  it("two runs within the same second never share a backup directory", async () => {
    await run("0.1.0", writePackage("0.1.0"));
    const worker = join(installHome, "plugin", "0.1.0", "roles", "worker.md");
    const firstCopy = join(installHome, "backups", "20260915T101500Z", "plugin", "0.1.0", "roles", "worker.md");

    writeFileSync(worker, "# first edit\n");
    const first = await run("0.1.0", writePackage("0.1.0"), { force: true });
    expect(first.result.backup?.dir).toBe("backups/20260915T101500Z");
    const firstBefore = { bytes: readFileSync(firstCopy, "utf8"), mtimeMs: statSync(firstCopy).mtimeMs };

    writeFileSync(worker, "# second edit\n");
    const second = await run("0.1.0", writePackage("0.1.0"), { force: true });
    expect(second.result.backup?.dir).toBe("backups/20260915T101500Z-2");

    expect({ bytes: readFileSync(firstCopy, "utf8"), mtimeMs: statSync(firstCopy).mtimeMs }).toEqual(firstBefore);
    expect(firstBefore.bytes).toBe("# first edit\n");
    const secondCopy = join(installHome, "backups", "20260915T101500Z-2", "plugin", "0.1.0", "roles", "worker.md");
    expect(readFileSync(secondCopy, "utf8")).toBe("# second edit\n");
    expect(modeOf(join(installHome, "backups", "20260915T101500Z-2"))).toBe(DIR_MODE);
    expect(second.writes.filter((path) => isWithinRoot(join(installHome, "backups", "20260915T101500Z"), path))).toEqual([]);

    const onDisk = await recordOnDisk();
    expect(onDisk.backups.map((backup) => backup.dir)).toEqual(["backups/20260915T101500Z", "backups/20260915T101500Z-2"]);
  });

  it("refuses a plan that was not built from the manifest, before writing anything", async () => {
    const source = writePackage("0.1.0");
    const manifest = await buildPayloadManifest(source);
    const scope = startWriteScope({ installHome, paseoHome, watch: [fakeHome] });
    try {
      const fsops = scope.fsops();
      const plan = await planInstall({
        installHome,
        version: "0.1.0",
        payload: manifest.files.slice(1),
        reader: createDiskReader({ fsops, fs: scope.fs }),
      });
      await expect(
        applyInstall({ plan, payload: manifest, record: undefined, installHome, paseoHome, fsops, fs: scope.fs, now: NOW }),
      ).rejects.toMatchObject({ reason: "plan-payload-mismatch" });
      expect(scope.writes).toEqual([]);
    } finally {
      scope.restore();
    }
  });

  it("refuses to copy a source file that changed after planning and never writes the record", async () => {
    const source = writePackage("0.1.0");
    const manifest = await buildPayloadManifest(source);
    writeFileSync(join(source, "roles", "worker.md"), "# tampered\n");
    await expect(run("0.1.0", source, { manifest })).rejects.toMatchObject({ reason: "source-changed" });
    expect(existsSync(join(installHome, "install.json"))).toBe(false);
  });
});
