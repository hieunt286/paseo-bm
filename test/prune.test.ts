/**
 * `install --prune` (bead bm-wp-111-cop.3).
 *
 * Every scenario seeds a fake `$HOME` with a real install home — payload
 * version directories, backups and an `install.json` written through the
 * record module — and runs the planner and applier with the write-scope guard
 * active, so a removal outside the install home fails the test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
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
import { dirname, join, relative } from "node:path";
import type { FsWrite } from "../src/fs-guard.js";
import { createFsOps, sha256 } from "../src/fsops.js";
import { isWithinRoot } from "../src/paths-guard.js";
import type { InstallRecord } from "../src/record.js";
import { createRecord, readRecord, writeRecord } from "../src/record.js";
import type { PrunePlan } from "../src/commands/prune.js";
import { PruneError, applyPrune, planPrune } from "../src/commands/prune.js";
import type { WriteScopeHarness } from "./helpers/write-scope.js";
import { startWriteScope } from "./helpers/write-scope.js";

const NOW = new Date("2026-09-15T10:15:00.000Z");
const LATER = new Date("2026-09-16T08:00:00.000Z");

let fakeHome: string;
let installHome: string;
let paseoHome: string;
let scope: WriteScopeHarness | undefined;

beforeEach(() => {
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-prune-")));
  installHome = join(fakeHome, ".paseo-bm");
  paseoHome = join(fakeHome, ".paseo");
  mkdirSync(paseoHome, { recursive: true });
});

afterEach(() => {
  scope?.restore();
  scope = undefined;
  rmSync(fakeHome, { recursive: true, force: true });
});

function payload(version: string): Record<string, string> {
  return {
    "paseo-plugin.json": '{ "id": "paseo-bm" }\n',
    "index.server.ts": `export const server = "${version}";\n`,
    "roles/worker.md": `# Worker ${version}\n`,
  };
}

function put(relativePath: string, text: string): void {
  const absolute = join(installHome, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

interface SeedOptions {
  readonly active?: string | null;
  readonly pluginDir?: string | null;
  readonly versions?: readonly string[];
  readonly backups?: readonly string[];
}

/** Writes payload dirs, backups and the record they are described by. */
async function seed(options: SeedOptions = {}): Promise<InstallRecord> {
  const versions = options.versions ?? ["0.0.9", "0.1.0"];
  const active = options.active === undefined ? "0.1.0" : options.active;
  const files = [];
  for (const version of versions) {
    for (const [path, text] of Object.entries(payload(version))) {
      const relativePath = `plugin/${version}/${path}`;
      put(relativePath, text);
      files.push({ path: relativePath, sha256: sha256(text), mode: 0o600 });
    }
  }
  const backups = (options.backups ?? ["20260914T090000Z"]).map((stamp) => {
    put(`backups/${stamp}/paseo-config.json`, '{ "pluginsEnabled": false }\n');
    put(`backups/${stamp}/plugin/0.0.9/roles/worker.md`, "# my edited worker\n");
    return { at: NOW.toISOString(), dir: `backups/${stamp}`, reason: "user-modified" };
  });

  const base = createRecord({ version: active ?? "0.1.0", installHome, paseo: { home: paseoHome }, at: NOW });
  const record: InstallRecord = {
    ...base,
    paseo: {
      ...base.paseo,
      pluginDir:
        options.pluginDir === undefined
          ? active === null
            ? null
            : join(installHome, "plugin", active)
          : options.pluginDir,
    },
    files,
    versions: versions.map((version) => ({
      version,
      dir: `plugin/${version}`,
      installedAt: NOW.toISOString(),
      active: version === active,
    })),
    backups,
  };
  await writeRecord(createFsOps({ root: installHome }), record);
  return record;
}

function guard(): WriteScopeHarness {
  scope = startWriteScope({ installHome, paseoHome, watch: [fakeHome] });
  return scope;
}

function tree(root: string = fakeHome): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        out[relative(root, absolute)] = `${readFileSync(absolute, "utf8")}@${statSync(absolute).mtimeMs}`;
      } else {
        out[relative(root, absolute)] = "<link>";
      }
    }
  };
  visit(root);
  return out;
}

async function run(
  options: { prune?: boolean; keepVersions?: string[]; keepBackups?: string[] } = {},
): Promise<{ plan: PrunePlan; result: Awaited<ReturnType<typeof applyPrune>>; writes: readonly FsWrite[] }> {
  const harness = guard();
  const fsops = harness.fsops();
  const record = await readRecord(fsops);
  const plan = await planPrune({
    prune: options.prune ?? true,
    record,
    fsops,
    fs: harness.fs,
    keepVersions: options.keepVersions,
    keepBackups: options.keepBackups,
  });
  const result = await applyPrune({ plan, record, fsops, fs: harness.fs, now: LATER });
  harness.assertNoViolations();
  const writes = [...harness.writes];
  harness.restore();
  scope = undefined;
  return { plan, result, writes };
}

function expectAllInsideInstallHome(writes: readonly FsWrite[]): void {
  for (const write of writes) {
    expect(isWithinRoot(installHome, write.canonicalPath), `${write.call} ${write.path}`).toBe(true);
  }
}

describe("without --prune", () => {
  it("removes nothing, reads nothing into a plan, and writes nothing", async () => {
    await seed();
    const before = tree();

    const { plan, result, writes } = await run({ prune: false });

    expect(plan.requested).toBe(false);
    expect(plan.actions).toEqual([]);
    expect(result.removedFiles).toEqual([]);
    expect(result.recordWritten).toBe(false);
    expect(writes).toEqual([]);
    expect(tree()).toEqual(before);
  });

  it("previewing with --prune writes nothing either", async () => {
    await seed();
    const before = tree();
    const harness = guard();
    const fsops = harness.fsops();
    const plan = await planPrune({ prune: true, record: await readRecord(fsops), fsops, fs: harness.fs });

    expect(plan.summary.byKind.delete).toBeGreaterThan(0);
    expect(harness.writes).toEqual([]);
    expect(tree()).toEqual(before);
  });
});

describe("with --prune", () => {
  it("removes the inactive version and the backups, keeps the active version, updates the record", async () => {
    await seed();

    const { plan, result, writes } = await run();

    expect(plan.versions.map((v) => [v.version, v.decision, v.reason])).toEqual([
      ["0.0.9", "delete", "old-version"],
      ["0.1.0", "keep", "active-version"],
    ]);
    // The preview names every backup file that will be lost.
    const deleted = plan.actions.filter((a) => a.kind === "delete").map((a) => a.target);
    expect(deleted).toEqual([
      "installHome/plugin/0.0.9",
      "installHome/backups/20260914T090000Z/paseo-config.json",
      "installHome/backups/20260914T090000Z/plugin/0.0.9/roles/worker.md",
      "installHome/backups/20260914T090000Z",
    ]);

    expect(existsSync(join(installHome, "plugin/0.0.9"))).toBe(false);
    expect(existsSync(join(installHome, "backups/20260914T090000Z"))).toBe(false);
    expect(readFileSync(join(installHome, "plugin/0.1.0/roles/worker.md"), "utf8")).toBe("# Worker 0.1.0\n");

    const record = await readRecord(createFsOps({ root: installHome }));
    expect(record?.versions.map((v) => v.version)).toEqual(["0.1.0"]);
    expect(record?.files.every((f) => f.path.startsWith("plugin/0.1.0/"))).toBe(true);
    expect(record?.files).toHaveLength(3);
    expect(record?.backups).toEqual([]);
    expect(record?.updatedAt).toBe(LATER.toISOString());
    expect(result.removedVersions.map((v) => v.version)).toEqual(["0.0.9"]);
    expect(result.recordWritten).toBe(true);

    expect(writes.some((w) => w.kind === "remove")).toBe(true);
    expectAllInsideInstallHome(writes);
  });

  it("keeps a user-modified file in an old version, and the version entry with it", async () => {
    await seed();
    put("plugin/0.0.9/roles/worker.md", "# I changed this\n");

    const { plan, result } = await run();

    const old = plan.versions.find((v) => v.version === "0.0.9");
    expect(old?.decision).toBe("partial");
    expect(old?.kept).toEqual([{ path: "plugin/0.0.9/roles/worker.md", reason: "user-modified" }]);

    expect(readFileSync(join(installHome, "plugin/0.0.9/roles/worker.md"), "utf8")).toBe("# I changed this\n");
    expect(existsSync(join(installHome, "plugin/0.0.9/index.server.ts"))).toBe(false);
    expect(existsSync(join(installHome, "plugin/0.0.9/paseo-plugin.json"))).toBe(false);

    const record = result.record;
    // The entry stays, so a later install never treats the directory as a partial payload.
    expect(record?.versions.map((v) => v.version)).toEqual(["0.0.9", "0.1.0"]);
    expect(record?.files.map((f) => f.path)).toContain("plugin/0.0.9/roles/worker.md");
    expect(record?.files.map((f) => f.path)).not.toContain("plugin/0.0.9/index.server.ts");
  });

  it("keeps an unrecorded file inside an old version", async () => {
    await seed();
    put("plugin/0.0.9/notes.txt", "mine\n");

    const { plan } = await run();

    expect(plan.versions.find((v) => v.version === "0.0.9")?.kept).toEqual([
      { path: "plugin/0.0.9/notes.txt", reason: "unrecorded" },
    ]);
    expect(readFileSync(join(installHome, "plugin/0.0.9/notes.txt"), "utf8")).toBe("mine\n");
  });

  it("never removes the version Paseo points at, even when no version is marked active", async () => {
    await seed({ active: null, pluginDir: join(installHome, "plugin", "0.0.9") });

    const { plan } = await run();

    expect(plan.versions.map((v) => [v.version, v.decision, v.reason])).toEqual([
      ["0.0.9", "keep", "registered-with-paseo"],
      ["0.1.0", "delete", "old-version"],
    ]);
    expect(existsSync(join(installHome, "plugin/0.0.9/roles/worker.md"))).toBe(true);
  });

  it("removes no version when none is active or registered", async () => {
    await seed({ active: null, pluginDir: null });
    const { plan } = await run();
    expect(plan.versions.map((v) => v.reason)).toEqual(["no-active-version", "no-active-version"]);
    expect(existsSync(join(installHome, "plugin/0.0.9"))).toBe(true);
    expect(existsSync(join(installHome, "plugin/0.1.0"))).toBe(true);
  });

  it("keeps versions and backups the caller names", async () => {
    await seed({ versions: ["0.0.8", "0.0.9", "0.1.0"] });
    const { plan } = await run({ keepVersions: ["0.0.9"], keepBackups: ["backups/20260914T090000Z"] });
    expect(plan.versions.map((v) => [v.version, v.decision])).toEqual([
      ["0.0.8", "delete"],
      ["0.0.9", "keep"],
      ["0.1.0", "keep"],
    ]);
    expect(plan.backups.map((b) => b.reason)).toEqual(["current-backup"]);
    expect(existsSync(join(installHome, "backups/20260914T090000Z/paseo-config.json"))).toBe(true);
  });

  it("leaves unrecorded directories under plugin/ and backups/ alone and reports them", async () => {
    await seed();
    put("plugin/0.2.0-partial/index.server.ts", "half\n");
    put("backups/foreign/thing.txt", "not ours\n");

    const { plan } = await run();

    expect(plan.unrecorded).toEqual(["plugin/0.2.0-partial", "backups/foreign"]);
    expect(plan.actions.filter((a) => a.reason === "unrecorded").map((a) => a.kind)).toEqual(["keep", "keep"]);
    expect(existsSync(join(installHome, "plugin/0.2.0-partial/index.server.ts"))).toBe(true);
    expect(existsSync(join(installHome, "backups/foreign/thing.txt"))).toBe(true);
  });

  it("does not follow a symlink out of the install home", async () => {
    await seed();
    const outside = join(fakeHome, "precious");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "outside\n");
    symlinkSync(outside, join(installHome, "plugin/0.0.9/link"));
    symlinkSync(outside, join(installHome, "backups/20260914T090000Z/link"));

    const { plan, writes } = await run();

    expect(plan.versions.find((v) => v.version === "0.0.9")?.kept).toEqual([
      { path: "plugin/0.0.9/link", reason: "symlink" },
    ]);
    expect(plan.backups[0]?.decision).toBe("keep");
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("outside\n");
    expect(existsSync(join(installHome, "backups/20260914T090000Z/paseo-config.json"))).toBe(true);
    expectAllInsideInstallHome(writes);
  });

  it("refuses record entries that point outside plugin/<ver> or backups/<stamp>", async () => {
    const seeded = await seed();
    await writeRecord(createFsOps({ root: installHome }), {
      ...seeded,
      backups: [{ at: NOW.toISOString(), dir: "plugin/0.1.0", reason: "bogus" }],
      versions: [...seeded.versions, { version: "x", dir: "backups", installedAt: NOW.toISOString(), active: false }],
    });

    const { plan } = await run();

    expect(plan.backups.map((b) => [b.decision, b.reason])).toEqual([["keep", "unexpected-location"]]);
    expect(plan.versions.find((v) => v.version === "x")?.reason).toBe("unexpected-location");
    expect(existsSync(join(installHome, "plugin/0.1.0/roles/worker.md"))).toBe(true);
    expect(existsSync(join(installHome, "backups/20260914T090000Z"))).toBe(true);
  });

  it("keeps a file edited between the preview and the removal", async () => {
    await seed();
    const harness = guard();
    const fsops = harness.fsops();
    const record = await readRecord(fsops);
    const plan = await planPrune({ prune: true, record, fsops, fs: harness.fs });

    writeFileSync(join(installHome, "plugin/0.0.9/roles/worker.md"), "# edited after preview\n");
    const result = await applyPrune({ plan, record, fsops, fs: harness.fs, now: LATER });
    harness.assertNoViolations();

    expect(result.kept).toContainEqual({ path: "plugin/0.0.9/roles/worker.md", reason: "changed-since-preview" });
    expect(readFileSync(join(installHome, "plugin/0.0.9/roles/worker.md"), "utf8")).toBe("# edited after preview\n");
    expect(result.record?.versions.map((v) => v.version)).toEqual(["0.0.9", "0.1.0"]);
  });

  it("drops record entries whose directories are already gone", async () => {
    await seed();
    rmSync(join(installHome, "plugin/0.0.9"), { recursive: true });
    const { plan, result } = await run();
    expect(plan.versions[0]?.decision).toBe("forget");
    expect(result.record?.versions.map((v) => v.version)).toEqual(["0.1.0"]);
  });

  it("refuses to apply against a record that changed after the preview", async () => {
    const seeded = await seed();
    const harness = guard();
    const fsops = harness.fsops();
    const plan = await planPrune({ prune: true, record: seeded, fsops, fs: harness.fs });
    const before = tree();
    await expect(
      applyPrune({ plan, record: { ...seeded, updatedAt: LATER.toISOString() }, fsops, fs: harness.fs }),
    ).rejects.toBeInstanceOf(PruneError);
    expect(tree()).toEqual(before);
  });

  it("is idempotent: a second prune removes nothing more", async () => {
    await seed();
    await run();
    const before = tree();
    const { result, writes } = await run();
    expect(result.removedFiles).toEqual([]);
    expect(result.recordWritten).toBe(false);
    expect(writes).toEqual([]);
    expect(tree()).toEqual(before);
  });
});
