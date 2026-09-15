import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
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
import type * as FsPromises from "node:fs/promises";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { FsOps } from "../src/fsops.js";
import {
  DIR_MODE,
  FILE_MODE,
  FsOpsError,
  backupStamp,
  canonicalRoot,
  createFsOps,
  sha256,
} from "../src/fsops.js";
import { PathGuardError } from "../src/paths-guard.js";

let scratch: string;
let root: string;
let fsops: FsOps;

beforeEach(() => {
  // Deliberately NOT realpath'ed: on macOS `os.tmpdir()` sits behind the
  // `/var` -> `/private/var` symlink, and the helper has to cope with that.
  scratch = mkdtempSync(join(tmpdir(), "paseo-bm-fsops-"));
  root = join(scratch, ".paseo-bm");
  fsops = createFsOps({ root });
});

afterEach(() => {
  // A test may have made a directory read-only to force a failure.
  for (const dir of [root, join(root, "plugin"), join(root, "plugin", "0.1.0")]) {
    if (existsSync(dir)) {
      chmodSync(dir, 0o700);
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Nanosecond timestamps, so "did not touch the file" is provable. */
async function times(path: string): Promise<{ mtimeNs: bigint; ctimeNs: bigint }> {
  const stats = await stat(path, { bigint: true });
  return { mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs };
}

describe("sha256", () => {
  it("matches the known digest of the empty input", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashes a string and the same bytes identically", () => {
    expect(sha256("plugin payload")).toBe(sha256(new TextEncoder().encode("plugin payload")));
  });

  it("changes when a single byte changes", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });
});

describe("backupStamp", () => {
  it("formats a UTC instant the way Design §3.1 shows", () => {
    expect(backupStamp(new Date("2026-09-15T10:15:00.123Z"))).toBe("20260915T101500Z");
  });

  it("produces a value usable as a single directory name", () => {
    expect(backupStamp()).toMatch(/^\d{8}T\d{6}Z$/);
  });
});

describe("canonicalRoot", () => {
  it("resolves a symlinked ancestor", () => {
    const real = join(scratch, "real");
    mkdirSync(real);
    const link = join(scratch, "link");
    symlinkSync(real, link);
    expect(canonicalRoot(join(link, "home"))).toBe(join(realpathSync(real), "home"));
  });

  it("keeps segments that do not exist yet", () => {
    expect(canonicalRoot(join(scratch, "a", "b", "c"))).toBe(join(realpathSync(scratch), "a", "b", "c"));
  });

  it("is what createFsOps stores, so a temp-dir root is not rejected as a symlink", () => {
    expect(fsops.root).toBe(realpathSync(scratch) + "/.paseo-bm");
  });
});

describe("ensureDir", () => {
  it("creates every missing level with 0700", async () => {
    const created = await fsops.ensureDir(join(root, "plugin", "0.1.0", "roles"));

    expect(created).toBe(join(fsops.root, "plugin", "0.1.0", "roles"));
    for (const dir of [
      fsops.root,
      join(fsops.root, "plugin"),
      join(fsops.root, "plugin", "0.1.0"),
      created,
    ]) {
      expect(mode(dir)).toBe(DIR_MODE);
      expect(DIR_MODE).toBe(0o700);
    }
  });

  it("is idempotent", async () => {
    await fsops.ensureDir(join(root, "backups"));
    await expect(fsops.ensureDir(join(root, "backups"))).resolves.toBe(join(fsops.root, "backups"));
  });

  it("refuses a directory outside the root", async () => {
    await expect(fsops.ensureDir(join(scratch, "elsewhere"))).rejects.toBeInstanceOf(PathGuardError);
  });
});

describe("writeFileAtomic — write then read back", () => {
  it("creates the file with the exact content and 0600, under 0700 directories", async () => {
    const target = join(root, "plugin", "0.1.0", "index.server.js");

    const result = await fsops.writeFileAtomic(target, "export const id = 'paseo-bm';\n");

    expect(result.outcome).toBe("created");
    expect(result.rewritten).toBe(true);
    expect(result.sha256).toBe(sha256("export const id = 'paseo-bm';\n"));
    expect(readFileSync(result.path, "utf8")).toBe("export const id = 'paseo-bm';\n");
    expect(mode(result.path)).toBe(FILE_MODE);
    expect(FILE_MODE).toBe(0o600);
    expect(mode(dirname(result.path))).toBe(DIR_MODE);
    expect(await fsops.hashFile(result.path)).toBe(result.sha256);
  });

  it("writes binary content byte for byte", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const result = await fsops.writeFileAtomic(join(root, "payload.bin"), bytes);
    expect(new Uint8Array(readFileSync(result.path))).toEqual(bytes);
  });

  it("honours an explicit mode", async () => {
    const result = await fsops.writeFileAtomic(join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o700 });
    expect(mode(result.path)).toBe(0o700);
  });

  it("replaces different content and reports `updated`", async () => {
    const target = join(root, "install.json");
    await fsops.writeFileAtomic(target, '{"schemaVersion":1}');

    const result = await fsops.writeFileAtomic(target, '{"schemaVersion":1,"version":"0.1.0"}');

    expect(result.outcome).toBe("updated");
    expect(result.rewritten).toBe(true);
    expect(readFileSync(target, "utf8")).toBe('{"schemaVersion":1,"version":"0.1.0"}');
    expect(readdirSync(dirname(target))).toEqual(["install.json"]);
  });

  it("leaves no temporary file behind on success", async () => {
    await fsops.writeFileAtomic(join(root, "install.json"), "{}");
    expect(readdirSync(fsops.root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a target outside the root", async () => {
    await expect(fsops.writeFileAtomic(join(scratch, "escape.txt"), "x")).rejects.toBeInstanceOf(
      PathGuardError,
    );
  });

  it("refuses a target reached through a symlink", async () => {
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    await fsops.ensureDir(root);
    symlinkSync(outside, join(fsops.root, "linked"));

    await expect(
      fsops.writeFileAtomic(join(fsops.root, "linked", "file.txt"), "x"),
    ).rejects.toMatchObject({ reason: "symlink-in-path" });
  });

  it("refuses to write over a directory", async () => {
    await fsops.ensureDir(join(root, "plugin"));
    await expect(fsops.writeFileAtomic(join(root, "plugin"), "x")).rejects.toBeInstanceOf(FsOpsError);
  });
});

describe("writeFileAtomic — identical content does not touch the file", () => {
  it("reports `unchanged` and leaves mtime and ctime alone", async () => {
    const target = join(root, "plugin", "0.1.0", "roles", "worker.md");
    const content = "# Beads Worker\n";
    const first = await fsops.writeFileAtomic(target, content);
    const before = await times(target);

    const second = await fsops.writeFileAtomic(target, content);
    const after = await times(target);

    expect(second.outcome).toBe("unchanged");
    expect(second.rewritten).toBe(false);
    expect(second.sha256).toBe(first.sha256);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).toBe(before.ctimeNs);
  });

  it("stays unchanged across many runs — this is what makes install idempotent", async () => {
    const target = join(root, "install.json");
    await fsops.writeFileAtomic(target, '{"schemaVersion":1}');
    const before = await times(target);

    for (let i = 0; i < 5; i += 1) {
      expect((await fsops.writeFileAtomic(target, '{"schemaVersion":1}')).outcome).toBe("unchanged");
    }

    expect((await times(target)).mtimeNs).toBe(before.mtimeNs);
  });

  it("fixes drifted permissions with chmod only, without rewriting the content", async () => {
    const target = join(root, "install.json");
    await fsops.writeFileAtomic(target, "{}");
    chmodSync(target, 0o644);
    const before = await times(target);

    const result = await fsops.writeFileAtomic(target, "{}");

    expect(result.outcome).toBe("mode-changed");
    expect(result.rewritten).toBe(false);
    expect(mode(target)).toBe(FILE_MODE);
    expect((await times(target)).mtimeNs).toBe(before.mtimeNs);
  });
});

describe("writeFileAtomic — a failure before rename is harmless", () => {
  it("keeps the previous file and leaves no partial file when the temp file cannot be created", async () => {
    const dir = join(root, "plugin", "0.1.0");
    const target = join(dir, "index.server.js");
    await fsops.writeFileAtomic(target, "old\n");
    const before = await times(target);

    // A read-only destination directory is a real interruption: the temp file
    // cannot be created, so the write dies well before the rename.
    chmodSync(dir, 0o500);
    try {
      await expect(fsops.writeFileAtomic(target, "new\n")).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(dir, 0o700);
    }

    expect(readFileSync(target, "utf8")).toBe("old\n");
    expect(readdirSync(dir)).toEqual(["index.server.js"]);
    expect(await times(target)).toEqual(before);
  });

  it("removes the temp file and keeps the old file when rename itself fails", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof FsPromises>();
      return {
        ...actual,
        default: actual,
        rename: async () => {
          throw Object.assign(new Error("simulated crash between fsync and rename"), { code: "EIO" });
        },
      };
    });

    try {
      const { createFsOps: createMocked } = await import("../src/fsops.js");
      const mocked = createMocked({ root });
      const dir = join(mocked.root, "plugin", "0.1.0");
      const target = join(dir, "index.server.js");

      // Seeded directly: the mocked `rename` would break the setup write too.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(target, "old\n", { mode: 0o600 });
      const before = await times(target);

      await expect(mocked.writeFileAtomic(target, "new\n")).rejects.toThrow(
        "simulated crash between fsync and rename",
      );

      // Old content survives, and nothing half-written is left in the
      // destination directory — ADR-002's whole recovery story.
      expect(readFileSync(target, "utf8")).toBe("old\n");
      expect(readdirSync(dir)).toEqual(["index.server.js"]);
      expect(await times(target)).toEqual(before);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("does not create the target at all when the very first write fails", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof FsPromises>();
      return {
        ...actual,
        default: actual,
        rename: async () => {
          throw Object.assign(new Error("simulated crash"), { code: "EIO" });
        },
      };
    });

    try {
      const { createFsOps: createMocked } = await import("../src/fsops.js");
      const mocked = createMocked({ root });
      const target = join(root, "install.json");

      await expect(mocked.writeFileAtomic(target, "{}")).rejects.toThrow("simulated crash");

      expect(existsSync(target)).toBe(false);
      expect(readdirSync(mocked.root)).toEqual([]);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});

describe("backupFile", () => {
  const stamp = "20260915T101500Z";

  it("copies into backups/<stamp>/ keeping the relative path", async () => {
    const source = join(root, "plugin", "0.1.0", "roles", "worker.md");
    await fsops.writeFileAtomic(source, "# Beads Worker\n");

    const backup = await fsops.backupFile(source, { backupDir: join(root, "backups", stamp) });

    expect(backup).toBe(join(fsops.root, "backups", stamp, "plugin", "0.1.0", "roles", "worker.md"));
    expect(readFileSync(backup!, "utf8")).toBe("# Beads Worker\n");
    expect(mode(backup!)).toBe(FILE_MODE);
    expect(mode(dirname(backup!))).toBe(DIR_MODE);
    // The original is still there: a backup never moves the file.
    expect(readFileSync(source, "utf8")).toBe("# Beads Worker\n");
  });

  it("uses an explicit name for a source outside the install home", async () => {
    const paseoConfig = join(scratch, ".paseo", "config.json");
    mkdirSync(dirname(paseoConfig), { recursive: true });
    writeFileSync(paseoConfig, '{"pluginsEnabled":false}');

    const backup = await fsops.backupFile(paseoConfig, {
      backupDir: join(root, "backups", stamp),
      as: "paseo-config.json",
    });

    expect(backup).toBe(join(fsops.root, "backups", stamp, "paseo-config.json"));
    expect(readFileSync(backup!, "utf8")).toBe('{"pluginsEnabled":false}');
  });

  it("refuses a source outside the base when no name is given", async () => {
    const outside = join(scratch, "outside.txt");
    writeFileSync(outside, "x");

    await expect(
      fsops.backupFile(outside, { backupDir: join(root, "backups", stamp) }),
    ).rejects.toMatchObject({ reason: "backup-source-outside-base" });
  });

  it("honours an explicit relativeTo base", async () => {
    const source = join(root, "plugin", "0.1.0", "shared", "contract.js");
    await fsops.writeFileAtomic(source, "x");

    const backup = await fsops.backupFile(source, {
      backupDir: join(root, "backups", stamp),
      relativeTo: join(root, "plugin"),
    });

    expect(backup).toBe(join(fsops.root, "backups", stamp, "0.1.0", "shared", "contract.js"));
  });

  it("returns undefined when there is nothing to back up", async () => {
    await expect(
      fsops.backupFile(join(root, "install.json"), { backupDir: join(root, "backups", stamp) }),
    ).resolves.toBeUndefined();
  });

  it("refuses a name that escapes the backup directory", async () => {
    const source = join(root, "install.json");
    await fsops.writeFileAtomic(source, "{}");

    await expect(
      fsops.backupFile(source, { backupDir: join(root, "backups", stamp), as: "../../escaped.json" }),
    ).rejects.toBeInstanceOf(PathGuardError);
  });

  it("refuses a backup directory outside the install home", async () => {
    const source = join(root, "install.json");
    await fsops.writeFileAtomic(source, "{}");

    await expect(
      fsops.backupFile(source, { backupDir: join(scratch, "elsewhere") }),
    ).rejects.toBeInstanceOf(PathGuardError);
  });
});

describe("chmodPath and hashFile", () => {
  it("chmod only applies inside the root", async () => {
    const outside = join(scratch, "outside.txt");
    writeFileSync(outside, "x");
    await expect(fsops.chmodPath(outside, 0o600)).rejects.toBeInstanceOf(PathGuardError);
  });

  it("chmod changes the bits of a file we own", async () => {
    const target = join(root, "install.json");
    await fsops.writeFileAtomic(target, "{}");
    await fsops.chmodPath(target, 0o400);
    expect(mode(target)).toBe(0o400);
  });

  it("hashFile returns undefined for a missing file", async () => {
    await expect(fsops.hashFile(join(root, "nope.json"))).resolves.toBeUndefined();
  });

  it("hashFile matches sha256 of the content on disk", async () => {
    const target = join(root, "install.json");
    writeFileSync(join(resolve(scratch), "outside.json"), "{}");
    await fsops.writeFileAtomic(target, '{"schemaVersion":1}');
    await expect(fsops.hashFile(target)).resolves.toBe(sha256('{"schemaVersion":1}'));
  });
});
