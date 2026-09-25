import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { summarizeActions } from "../src/action.js";
import { FILE_MODE, createFsOps, sha256 } from "../src/fsops.js";
import type { FsOps } from "../src/fsops.js";
import {
  ABSENT,
  MODE_CHANGED_REASON,
  OWNERSHIP_STATUSES,
  classifyOwnership,
  createDiskReader,
  defaultInstallAction,
  findRecordedFile,
  inspectOwnership,
  installHomeLabel,
  summarizeOwnership,
} from "../src/ownership.js";
import type { DiskReader, Ownership, OwnershipTarget } from "../src/ownership.js";
import { createRecord, recordPath } from "../src/record.js";
import type { FileRecord, InstallRecord } from "../src/record.js";
import { withWriteScope } from "./helpers/write-scope.js";

const OLD = "old worker role\n";
const NEW = "new worker role\n";
const EDITED = "the user rewrote this\n";

let scratch: string;
let installHome: string;
let fsops: FsOps;
let reader: DiskReader;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "paseo-bm-ownership-"));
  installHome = join(scratch, ".paseo-bm");
  mkdirSync(installHome, { recursive: true, mode: 0o700 });
  fsops = createFsOps({ root: installHome });
  reader = createDiskReader({ fsops });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Writes a payload file the way the installer would: 0600, real bytes. */
function install(relativePath: string, content: string, mode = FILE_MODE): void {
  const absolute = join(installHome, relativePath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  writeFileSync(absolute, content, { mode });
  chmodSync(absolute, mode);
}

function fileRecord(relativePath: string, content: string, mode = FILE_MODE): FileRecord {
  return { path: relativePath, sha256: sha256(content), mode };
}

function recordWith(files: readonly FileRecord[]): InstallRecord {
  const base = createRecord({
    version: "0.1.0",
    installHome,
    paseo: { home: join(scratch, ".paseo") },
    at: "2026-09-15T10:15:00.000Z",
  });
  return { ...base, files };
}

function target(relativePath: string, expected: string | undefined): OwnershipTarget {
  return expected === undefined
    ? { path: relativePath }
    : { path: relativePath, expectedSha256: sha256(expected) };
}

function statusOf(entries: readonly Ownership[], path: string): string {
  const found = entries.find((entry) => entry.path === path);
  if (found === undefined) {
    throw new Error(`no classification for ${path}`);
  }
  return found.status;
}

describe("the five states of Design §5.3", () => {
  const path = "plugin/0.1.0/roles/worker.md";

  it("unchanged: recorded, on disk, hash matches the record and the payload", async () => {
    install(path, OLD);
    const entries = await inspectOwnership({
      installHome,
      record: recordWith([fileRecord(path, OLD)]),
      targets: [target(path, OLD)],
      reader,
    });

    expect(statusOf(entries, path)).toBe("unchanged");
    expect(defaultInstallAction(entries[0]!)).toMatchObject({ kind: "skip", reason: "unchanged" });
  });

  it("outdated: hash matches the old record but the payload is different", async () => {
    install(path, OLD);
    const entries = await inspectOwnership({
      installHome,
      record: recordWith([fileRecord(path, OLD)]),
      targets: [target(path, NEW)],
      reader,
    });

    expect(statusOf(entries, path)).toBe("outdated");
    expect(defaultInstallAction(entries[0]!)).toMatchObject({ kind: "update", reason: "outdated" });
  });

  it("user-modified: the bytes on disk are not the bytes the record claims", async () => {
    install(path, EDITED);
    const entries = await inspectOwnership({
      installHome,
      record: recordWith([fileRecord(path, OLD)]),
      targets: [target(path, NEW)],
      reader,
    });

    expect(statusOf(entries, path)).toBe("user-modified");
    // Default is a conflict that needs a human decision (exit code 5), never a
    // silent overwrite.
    expect(defaultInstallAction(entries[0]!)).toMatchObject({ kind: "conflict", reason: "user-modified" });
    expect(summarizeOwnership(entries).needsDecision).toBe(true);
  });

  it("conflict: the file is on disk but is not in files[]", async () => {
    install(path, EDITED);
    const entries = await inspectOwnership({
      installHome,
      record: recordWith([]),
      targets: [target(path, NEW)],
      reader,
    });

    expect(statusOf(entries, path)).toBe("conflict");
    expect(defaultInstallAction(entries[0]!)).toMatchObject({ kind: "conflict", reason: "conflict" });
  });

  it("missing: recorded as installed but gone from disk", async () => {
    const entries = await inspectOwnership({
      installHome,
      record: recordWith([fileRecord(path, OLD)]),
      targets: [target(path, OLD)],
      reader,
    });

    expect(entries[0]).toMatchObject({
      status: "missing",
      detail: "recorded as installed but no longer on disk",
    });
    expect(defaultInstallAction(entries[0]!)).toMatchObject({ kind: "create", reason: "missing" });
  });

  it("classifies every destination into exactly one of the five", async () => {
    install("plugin/0.1.0/a.md", OLD);
    install("plugin/0.1.0/b.md", OLD);
    install("plugin/0.1.0/c.md", EDITED);
    install("plugin/0.1.0/d.md", EDITED);

    const entries = await inspectOwnership({
      installHome,
      record: recordWith([
        fileRecord("plugin/0.1.0/a.md", OLD),
        fileRecord("plugin/0.1.0/b.md", OLD),
        fileRecord("plugin/0.1.0/c.md", OLD),
        fileRecord("plugin/0.1.0/e.md", OLD),
      ]),
      targets: [
        target("plugin/0.1.0/a.md", OLD),
        target("plugin/0.1.0/b.md", NEW),
        target("plugin/0.1.0/c.md", NEW),
        target("plugin/0.1.0/d.md", NEW),
        target("plugin/0.1.0/e.md", NEW),
      ],
      reader,
    });

    expect(entries.map((entry) => entry.status)).toEqual([
      "unchanged",
      "outdated",
      "user-modified",
      "conflict",
      "missing",
    ]);
    for (const entry of entries) {
      expect(OWNERSHIP_STATUSES).toContain(entry.status);
    }
    expect(summarizeOwnership(entries).byStatus).toEqual({
      unchanged: 1,
      outdated: 1,
      "user-modified": 1,
      conflict: 1,
      missing: 1,
    });
  });
});

describe("the real reach of the three conflicting states (ADR-002 decision 4)", () => {
  /** Every payload file of a version, as the installer would list them. */
  const payload = (version: string): readonly string[] => [
    `plugin/${version}/manifest.json`,
    `plugin/${version}/index.server.js`,
    `plugin/${version}/roles/manager.md`,
    `plugin/${version}/roles/worker.md`,
    `plugin/${version}/roles/reviewer.md`,
  ];

  it("an upgrade into plugin/<new version>/ makes every destination missing", async () => {
    // 0.1.0 is installed, and the user has even edited one of its files.
    for (const path of payload("0.1.0")) {
      install(path, OLD);
    }
    install("plugin/0.1.0/roles/worker.md", EDITED);

    const record = recordWith(payload("0.1.0").map((path) => fileRecord(path, OLD)));

    const entries = await inspectOwnership({
      installHome,
      record,
      targets: payload("0.2.0").map((path) => target(path, NEW)),
      reader,
    });

    expect(entries).toHaveLength(5);
    expect(entries.every((entry) => entry.status === "missing")).toBe(true);
    expect(summarizeOwnership(entries)).toEqual({
      total: 5,
      byStatus: { unchanged: 0, outdated: 0, "user-modified": 0, conflict: 0, missing: 5 },
      needsDecision: false,
    });

    // Therefore the plan for an upgrade is nothing but `create`: there is no
    // keep/overwrite question to ask on this path.
    const actions = entries.map((entry) => defaultInstallAction(entry));
    expect(actions.every((action) => action.kind === "create" && action.reason === "missing")).toBe(true);
    expect(summarizeActions(actions).conflicts).toBe(false);
    expect(new Set(entries.map((entry) => entry.detail))).toEqual(new Set(["not installed yet"]));
  });

  it("installing the same version again produces no writing action at all (Design §9)", async () => {
    for (const path of payload("0.1.0")) {
      install(path, OLD);
    }
    const record = recordWith(payload("0.1.0").map((path) => fileRecord(path, OLD)));

    const entries = await inspectOwnership({
      installHome,
      record,
      targets: payload("0.1.0").map((path) => target(path, OLD)),
      reader,
    });

    expect(entries.every((entry) => entry.status === "unchanged")).toBe(true);
    const summary = summarizeActions(entries.map((entry) => defaultInstallAction(entry)));
    expect(summary.writes).toBe(false);
    expect(summary.byKind.skip).toBe(5);
  });

  it("repairing the active version directory is where the conflicting states live", async () => {
    for (const path of payload("0.1.0")) {
      install(path, OLD);
    }
    rmSync(join(installHome, "plugin/0.1.0/roles/reviewer.md"));
    install("plugin/0.1.0/roles/worker.md", EDITED);

    const entries = await inspectOwnership({
      installHome,
      record: recordWith(payload("0.1.0").map((path) => fileRecord(path, OLD))),
      targets: payload("0.1.0").map((path) => target(path, OLD)),
      reader,
    });

    expect(statusOf(entries, "plugin/0.1.0/roles/worker.md")).toBe("user-modified");
    expect(statusOf(entries, "plugin/0.1.0/roles/reviewer.md")).toBe("missing");
    expect(statusOf(entries, "plugin/0.1.0/manifest.json")).toBe("unchanged");
  });

  it("install.json itself is classified against an explicit baseline", async () => {
    const recordFile = recordPath(installHome);
    writeFileSync(recordFile, EDITED, { mode: FILE_MODE });

    const entries = await inspectOwnership({
      installHome,
      // The record cannot list itself in `files[]`, so the baseline is passed in.
      record: recordWith([]),
      targets: [
        {
          path: "install.json",
          expectedSha256: sha256(NEW),
          recorded: { path: "install.json", sha256: sha256(OLD), mode: FILE_MODE },
        },
      ],
      reader,
    });

    expect(entries[0]!.absolutePath).toBe(recordFile);
    expect(entries[0]!.status).toBe("user-modified");
  });
});

describe("evidence is the hash and nothing else", () => {
  const path = "plugin/0.1.0/roles/worker.md";

  it("an old mtime on identical bytes is still unchanged", async () => {
    install(path, OLD);
    const longAgo = new Date("2001-01-01T00:00:00.000Z");
    utimesSync(join(installHome, path), longAgo, longAgo);

    const entries = await inspectOwnership({
      installHome,
      record: recordWith([fileRecord(path, OLD)]),
      targets: [target(path, OLD)],
      reader,
    });

    expect(statusOf(entries, path)).toBe("unchanged");
  });

  it("a same-length edit with a fresh mtime is still user-modified", async () => {
    const sameLength = OLD.replace("old", "new");
    expect(sameLength).toHaveLength(OLD.length);
    install(path, sameLength);

    const entries = await inspectOwnership({
      installHome,
      record: recordWith([fileRecord(path, OLD)]),
      targets: [target(path, sameLength)],
      reader,
    });

    expect(statusOf(entries, path)).toBe("user-modified");
    // Even though the bytes happen to be the ones the payload wants, the file
    // no longer matches the record, so it is not silently adopted.
    expect(entries[0]!.contentMatchesExpected).toBe(true);
    expect(defaultInstallAction(entries[0]!).kind).toBe("conflict");
  });

  it("a symlink standing where one of our files belongs is a conflict", async () => {
    install("plugin/0.1.0/real.md", OLD);
    symlinkSync(join(installHome, "plugin/0.1.0/real.md"), join(installHome, "plugin/0.1.0/roles.md"));

    const entries = await inspectOwnership({
      installHome,
      record: recordWith([fileRecord("plugin/0.1.0/roles.md", OLD)]),
      targets: [target("plugin/0.1.0/roles.md", OLD)],
      reader,
    });

    expect(entries[0]).toMatchObject({
      status: "conflict",
      detail: "something that is not a regular file is in the way",
    });
  });

  it("a directory standing where one of our files belongs is a conflict", async () => {
    mkdirSync(join(installHome, "plugin/0.1.0/roles.md"), { recursive: true, mode: 0o700 });

    const entries = await inspectOwnership({
      installHome,
      record: recordWith([]),
      targets: [target("plugin/0.1.0/roles.md", OLD)],
      reader,
    });

    expect(entries[0]!.status).toBe("conflict");
    expect(entries[0]!.disk.isFile).toBe(false);
  });
});

describe("permissions show up as an action, never as a silent chmod", () => {
  const path = "plugin/0.1.0/roles/worker.md";

  it("right content, wrong mode is an update with the mode-changed reason", async () => {
    install(path, OLD, 0o644);

    const entries = await inspectOwnership({
      installHome,
      record: recordWith([fileRecord(path, OLD)]),
      targets: [target(path, OLD)],
      reader,
    });

    expect(entries[0]!.status).toBe("unchanged");
    expect(entries[0]!.modeMatchesExpected).toBe(false);
    expect(defaultInstallAction(entries[0]!)).toMatchObject({
      kind: "update",
      reason: MODE_CHANGED_REASON,
      detail: "permissions are 0644, paseo-bm writes 0600",
    });
  });

  it("a clean re-run has no mode drift to fix, so it still plans zero writes", async () => {
    install(path, OLD);

    const entries = await inspectOwnership({
      installHome,
      record: recordWith([fileRecord(path, OLD)]),
      targets: [target(path, OLD)],
      reader,
    });

    expect(summarizeActions(entries.map((entry) => defaultInstallAction(entry))).writes).toBe(false);
  });

  it("a probe with no payload hash ignores the mode entirely", () => {
    // `uninstall` and `doctor` only ask "is this still ours"; they are not
    // about to write, so a permission difference is not their business.
    const ownership = classifyOwnership({
      target: { path: "plugin/0.1.0/roles/worker.md" },
      recorded: { path: "plugin/0.1.0/roles/worker.md", sha256: sha256(OLD), mode: FILE_MODE },
      disk: { present: true, isFile: true, sha256: sha256(OLD), mode: 0o644 },
    });

    expect(ownership.status).toBe("unchanged");
    expect(defaultInstallAction(ownership)).toMatchObject({ kind: "skip", reason: "unchanged" });
  });
});

describe("--force", () => {
  it("turns a user-modified conflict into an update that names the backup", () => {
    const ownership = classifyOwnership({
      target: { path: "plugin/0.1.0/roles/worker.md", expectedSha256: sha256(NEW) },
      recorded: { path: "plugin/0.1.0/roles/worker.md", sha256: sha256(OLD), mode: FILE_MODE },
      disk: { present: true, isFile: true, sha256: sha256(EDITED), mode: FILE_MODE },
    });

    expect(defaultInstallAction(ownership, { force: true })).toMatchObject({
      kind: "update",
      reason: "user-modified",
      detail: "overwritten because --force was given; the previous file is backed up first",
    });
  });

  it("does not touch a conflict that is not ours", () => {
    const ownership = classifyOwnership({
      target: { path: "plugin/0.1.0/stray.md", expectedSha256: sha256(NEW) },
      disk: { present: true, isFile: true, sha256: sha256(EDITED), mode: FILE_MODE },
    });

    expect(defaultInstallAction(ownership, { force: true })).toMatchObject({
      kind: "conflict",
      reason: "conflict",
    });
  });
});

describe("shape of a classification", () => {
  it("labels a target the way Design §4.4 writes it", () => {
    expect(installHomeLabel("plugin/0.1.0/roles/worker.md")).toBe("installHome/plugin/0.1.0/roles/worker.md");
    expect(installHomeLabel("install.json")).toBe("installHome/install.json");
  });

  it("keeps a caller-supplied label and location", () => {
    const ownership = classifyOwnership({
      target: { path: "install.json", label: "installHome/install.json", location: "install-home" },
      disk: ABSENT,
    });

    expect(ownership).toMatchObject({
      target: "installHome/install.json",
      location: "install-home",
      status: "missing",
      detail: "not installed yet",
      recorded: undefined,
    });
  });

  it("finds a recorded file by its relative path only", () => {
    const record = recordWith([fileRecord("plugin/0.1.0/roles/worker.md", OLD)]);

    expect(findRecordedFile(record, "plugin/0.1.0/roles/worker.md")?.sha256).toBe(sha256(OLD));
    expect(findRecordedFile(record, "plugin/0.2.0/roles/worker.md")).toBeUndefined();
    expect(findRecordedFile(undefined, "plugin/0.1.0/roles/worker.md")).toBeUndefined();
  });

  it("reads absence as a value, not an exception", async () => {
    await expect(reader.read(join(installHome, "plugin/0.1.0/nothing/here.md"))).resolves.toEqual(ABSENT);
  });
});

describe("the module only reads", () => {
  it("classifies a whole install without writing anything", async () => {
    install("plugin/0.1.0/roles/worker.md", OLD);
    install("plugin/0.1.0/roles/stray.md", EDITED);

    await withWriteScope({ installHome, watch: [scratch] }, async (scope) => {
      const entries = await inspectOwnership({
        installHome,
        record: recordWith([fileRecord("plugin/0.1.0/roles/worker.md", OLD)]),
        targets: [
          target("plugin/0.1.0/roles/worker.md", NEW),
          target("plugin/0.1.0/roles/stray.md", NEW),
          target("plugin/0.2.0/roles/worker.md", NEW),
        ],
        reader: createDiskReader({ fsops: createFsOps({ root: installHome, fs: scope.fs }) }),
      });

      expect(entries.map((entry) => entry.status)).toEqual(["outdated", "conflict", "missing"]);
      expect(scope.writes).toEqual([]);
    });
  });
});
