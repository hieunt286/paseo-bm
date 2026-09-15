import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WriteScopeError,
  canonicalPath,
  createWriteGuard,
  createWriteScope,
  describeWriteScope,
  isWriteAllowed,
  isWriteFlags,
} from "../src/fs-guard.js";
import { acquireLock } from "../src/lock.js";
import type { WriteScopeHarness, WriteScopeOptions } from "./helpers/write-scope.js";
import { startWriteScope, withWriteScope } from "./helpers/write-scope.js";

let scratch: string;
let fakeHome: string;
let installHome: string;
let paseoHome: string;
let skillsDir: string;
let outsideFile: string;

const started: WriteScopeHarness[] = [];

/** Starts a harness whose `restore()` is guaranteed by `afterEach`. */
function start(options: Partial<WriteScopeOptions> = {}): WriteScopeHarness {
  const harness = startWriteScope({ installHome, paseoHome, watch: [fakeHome], ...options });
  started.push(harness);
  return harness;
}

beforeEach(() => {
  // Everything below is the fake `$HOME` an integration test would build. It is
  // laid out *before* any guard is running, so setup is never judged.
  scratch = mkdtempSync(join(tmpdir(), "paseo-bm-fs-guard-"));
  fakeHome = join(scratch, "home");
  installHome = join(fakeHome, ".paseo-bm");
  paseoHome = join(fakeHome, ".paseo");
  skillsDir = join(fakeHome, ".agents", "skills");
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(paseoHome, { recursive: true });
  mkdirSync(installHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(paseoHome, "config.json"), "{}\n");
  outsideFile = join(skillsDir, "existing.md");
  writeFileSync(outsideFile, "owned by the skills CLI\n");
});

afterEach(() => {
  // Restore in reverse order: a later patch wraps the earlier one.
  while (started.length > 0) {
    started.pop()!.restore();
  }
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The scope itself
// ---------------------------------------------------------------------------

describe("write scope", () => {
  it("allows the install home and everything under it", () => {
    const scope = createWriteScope({ installHome, paseoHome });
    expect(isWriteAllowed(scope, installHome)).toBe(true);
    expect(isWriteAllowed(scope, join(installHome, "install.json"))).toBe(true);
    expect(isWriteAllowed(scope, join(installHome, "plugin", "0.1.0", "index.server.js"))).toBe(true);
  });

  it("allows exactly one file inside the Paseo home", () => {
    const scope = createWriteScope({ installHome, paseoHome });
    expect(isWriteAllowed(scope, join(paseoHome, "config.json"))).toBe(true);
    expect(isWriteAllowed(scope, join(paseoHome, "config.json.bak"))).toBe(false);
    expect(isWriteAllowed(scope, join(paseoHome, "agents", "a.json"))).toBe(false);
    expect(isWriteAllowed(scope, paseoHome)).toBe(false);
  });

  it("refuses the skills directories (ADR-003: they belong to the skills CLI)", () => {
    const scope = createWriteScope({ installHome, paseoHome });
    for (const dir of [".agents", ".claude", ".codex"]) {
      const skill = join(fakeHome, dir, "skills", "creating-beads", "SKILL.md");
      expect(isWriteAllowed(scope, skill)).toBe(false);
    }
  });

  it("refuses `..` escapes and the home directory itself", () => {
    const scope = createWriteScope({ installHome, paseoHome });
    expect(isWriteAllowed(scope, join(installHome, "..", "stray.txt"))).toBe(false);
    expect(isWriteAllowed(scope, fakeHome)).toBe(false);
    expect(isWriteAllowed(scope, "/etc/passwd")).toBe(false);
  });

  it("refuses a path that only looks local because of a symlink", () => {
    symlinkSync(join(fakeHome, ".agents"), join(installHome, "escape"));
    const scope = createWriteScope({ installHome, paseoHome });
    // Lexically inside the install home, really inside the skills tree.
    expect(isWriteAllowed(scope, join(installHome, "escape", "skills", "x.md"))).toBe(false);
  });

  it("copes with an install home reached through a symlink", () => {
    // `os.tmpdir()` on macOS is behind /var -> /private/var, so the configured
    // path and its canonical form differ. Both have to be accepted.
    const scope = createWriteScope({ installHome, paseoHome });
    expect(isWriteAllowed(scope, join(installHome, "install.json"))).toBe(true);
    expect(isWriteAllowed(scope, join(canonicalPath(installHome), "install.json"))).toBe(true);
  });

  it("describes itself in a way a failure report can print", () => {
    const scope = createWriteScope({ installHome, paseoHome });
    expect(describeWriteScope(scope)).toContain(installHome);
    expect(describeWriteScope(scope)).toContain(join(paseoHome, "config.json"));
  });

  it("knows which `open` flags write", () => {
    expect(isWriteFlags("r")).toBe(false);
    expect(isWriteFlags(undefined)).toBe(false);
    expect(isWriteFlags("r+")).toBe(true);
    expect(isWriteFlags("w")).toBe(true);
    expect(isWriteFlags("wx")).toBe(true);
    expect(isWriteFlags("a")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Proof the helper knows how to go red
// ---------------------------------------------------------------------------

/**
 * Deliberately wrong code, kept at module scope so it reads exactly like the
 * product bug it stands in for: copying a skill into the agent's skills
 * directory, which ADR-003 decision 1 forbids outright.
 */
function installSkillTheWrongWay(targetSkillsDir: string): string {
  const dir = join(targetSkillsDir, "creating-beads");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, "# creating-beads\n");
  return file;
}

describe("the helper goes red on an out-of-scope write", () => {
  it("catches a skill copied into the skills directory, and stops it", () => {
    const scope = start();

    expect(() => installSkillTheWrongWay(skillsDir)).toThrow(WriteScopeError);

    // Recorded...
    expect(scope.violations).toHaveLength(1);
    expect(scope.violations[0]).toMatchObject({
      kind: "make-dir",
      call: "fs.mkdirSync",
      path: join(skillsDir, "creating-beads"),
      allowed: false,
      blocked: true,
    });
    // ...and never reached the disk.
    expect(existsSync(join(skillsDir, "creating-beads"))).toBe(false);
  });

  it("fails the test through `assertNoViolations`", () => {
    const scope = start();
    expect(() => installSkillTheWrongWay(skillsDir)).toThrow(WriteScopeError);

    // This is what makes a test red: the assertion the suite ends with.
    expect(() => {
      scope.assertNoViolations();
    }).toThrow(/landed outside the paseo-bm write scope/);
    expect(() => {
      scope.assertNoViolations();
    }).toThrow(join(skillsDir, "creating-beads"));
  });

  it("still records the violation when the write is allowed to happen", async () => {
    // `record` mode is for runs that must not be interrupted half way.
    await expect(
      withWriteScope({ installHome, paseoHome, watch: [fakeHome], mode: "record" }, () => {
        installSkillTheWrongWay(skillsDir);
      }),
    ).rejects.toThrow(/landed outside the paseo-bm write scope/);

    // In `record` mode the write really did happen, which is the whole point:
    // the run is observed, not altered.
    expect(existsSync(join(skillsDir, "creating-beads", "SKILL.md"))).toBe(true);
  });

  it("goes quiet again once the guard is turned off", () => {
    const scope = start();
    scope.restore();

    const file = installSkillTheWrongWay(skillsDir);

    expect(existsSync(file)).toBe(true);
    expect(scope.writes).toHaveLength(0);
    expect(() => {
      scope.assertNoViolations();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Every way to write
// ---------------------------------------------------------------------------

describe("every write path is covered", () => {
  it("refuses the synchronous ones", () => {
    const scope = start();
    const target = join(skillsDir, "victim");

    expect(() => writeFileSync(target, "x")).toThrow(WriteScopeError);
    expect(() => mkdirSync(target)).toThrow(WriteScopeError);
    expect(() => rmSync(outsideFile)).toThrow(WriteScopeError);
    expect(() => unlinkSync(outsideFile)).toThrow(WriteScopeError);
    expect(() => renameSync(outsideFile, target)).toThrow(WriteScopeError);
    expect(() => symlinkSync(installHome, target)).toThrow(WriteScopeError);
    expect(() => chmodSync(outsideFile, 0o600)).toThrow(WriteScopeError);
    expect(() => openSync(target, "w")).toThrow(WriteScopeError);

    expect(scope.violations.map((write) => write.kind)).toEqual([
      "write-file",
      "make-dir",
      "remove",
      "remove",
      "rename",
      "symlink",
      "chmod",
      "open-write",
    ]);
    // Nothing on disk moved.
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(outsideFile, "utf8")).toBe("owned by the skills CLI\n");
  });

  it("refuses the promise ones", async () => {
    const scope = start();
    const target = join(skillsDir, "victim");

    await expect(writeFile(target, "x")).rejects.toBeInstanceOf(WriteScopeError);
    await expect(mkdir(target)).rejects.toBeInstanceOf(WriteScopeError);
    await expect(rm(outsideFile)).rejects.toBeInstanceOf(WriteScopeError);
    await expect(rename(outsideFile, target)).rejects.toBeInstanceOf(WriteScopeError);
    await expect(symlink(installHome, target)).rejects.toBeInstanceOf(WriteScopeError);
    await expect(chmod(outsideFile, 0o600)).rejects.toBeInstanceOf(WriteScopeError);

    expect(scope.violations.map((write) => write.call)).toEqual([
      "fs.promises.writeFile",
      "fs.promises.mkdir",
      "fs.promises.rm",
      "fs.promises.rename",
      "fs.promises.symlink",
      "fs.promises.chmod",
    ]);
    expect(existsSync(target)).toBe(false);
  });

  it("catches a rename that carries a file out of the install home", () => {
    const scope = start();
    const inside = join(installHome, "install.json");
    writeFileSync(inside, "{}\n");

    expect(() => renameSync(inside, join(skillsDir, "install.json"))).toThrow(WriteScopeError);
    expect(readFileSync(inside, "utf8")).toBe("{}\n");
    expect(scope.violations).toHaveLength(1);
  });

  it("catches a write that travels through a symlink out of the install home", () => {
    const scope = start();
    symlinkSync(skillsDir, join(installHome, "escape"));

    expect(() => writeFileSync(join(installHome, "escape", "SKILL.md"), "x")).toThrow(
      WriteScopeError,
    );
    expect(scope.violations[0]?.canonicalPath).toBe(
      join(canonicalPath(skillsDir), "SKILL.md"),
    );
    expect(existsSync(join(skillsDir, "SKILL.md"))).toBe(false);
  });

  it("leaves reads alone", () => {
    const scope = start();
    expect(readFileSync(outsideFile, "utf8")).toBe("owned by the skills CLI\n");
    const fd = openSync(outsideFile, "r");
    closeSync(fd);
    expect(scope.writes).toHaveLength(0);
  });

  it("ignores writes outside the watched roots", () => {
    const scope = start({ watch: [fakeHome] });
    const elsewhere = join(scratch, "elsewhere.txt");

    writeFileSync(elsewhere, "not our business");

    expect(existsSync(elsewhere)).toBe(true);
    expect(scope.writes).toHaveLength(0);
  });

  it("watches the fake home by default", () => {
    // Default watch = the parents of the install home and the Paseo home.
    const scope = startWriteScope({ installHome, paseoHome });
    started.push(scope);
    expect(() => writeFileSync(join(skillsDir, "x.md"), "x")).toThrow(WriteScopeError);
    expect(scope.violations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Legitimate work is not disturbed
// ---------------------------------------------------------------------------

describe("writes we own are not blocked", () => {
  it("lets every kind of write through inside the install home", async () => {
    const scope = start();
    const dir = join(installHome, "plugin", "0.1.0");

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.server.js"), "export {};\n");
    chmodSync(join(dir, "index.server.js"), 0o600);
    renameSync(join(dir, "index.server.js"), join(dir, "index.js"));
    symlinkSync(join(dir, "index.js"), join(dir, "current.js"));
    await writeFile(join(installHome, "install.json"), "{}\n");
    rmSync(join(dir, "current.js"));

    scope.assertNoViolations();
    expect(scope.violations).toHaveLength(0);
    expect(scope.writes.length).toBeGreaterThan(0);
    expect(scope.paths()).toContain(join(installHome, "install.json"));
  });

  it("lets Paseo's config.json be rewritten but nothing else in that home", () => {
    const scope = start();
    const config = join(paseoHome, "config.json");

    writeFileSync(config, '{"plugins":{}}\n');
    expect(readFileSync(config, "utf8")).toBe('{"plugins":{}}\n');
    scope.assertNoViolations();

    expect(() => writeFileSync(join(paseoHome, "agents.json"), "{}")).toThrow(WriteScopeError);
    expect(scope.violations).toHaveLength(1);
  });

  it("lets a complete fsops write run through the guarded filesystem", async () => {
    const scope = start();
    const fsops = scope.fsops();

    const first = await fsops.writeFileAtomic(join(installHome, "install.json"), '{"v":1}');
    const again = await fsops.writeFileAtomic(join(installHome, "install.json"), '{"v":1}');

    expect(first.outcome).toBe("created");
    expect(again.outcome).toBe("unchanged");
    expect(readFileSync(join(installHome, "install.json"), "utf8")).toBe('{"v":1}');
    scope.assertNoViolations();
  });

  it("covers code that bypasses the injectable seam, such as the lock", () => {
    const scope = start();

    const lock = acquireLock(installHome, { handleSignals: false });
    lock.release();

    // `src/lock.ts` imports `node:fs` directly and never sees the guard's fs
    // object; the process-wide patch is what makes it observable.
    scope.assertNoViolations();
    expect(scope.paths()).toContain(join(installHome, ".lock"));
  });

  it("keeps the symlink it is asked to create inside the install home", () => {
    const scope = start();
    const link = join(installHome, "current");
    symlinkSync(join(installHome, "plugin", "0.1.0"), link);

    expect(readlinkSync(link)).toBe(join(installHome, "plugin", "0.1.0"));
    scope.assertNoViolations();
  });
});

// ---------------------------------------------------------------------------
// The injectable seam on its own
// ---------------------------------------------------------------------------

describe("the injectable seam", () => {
  it("guards writes without patching anything global", async () => {
    const scope = start({ patchNodeFs: false });

    // Injected: guarded.
    await expect(scope.fs.writeFile(join(skillsDir, "SKILL.md"), "x")).rejects.toBeInstanceOf(
      WriteScopeError,
    );
    expect(scope.violations).toHaveLength(1);

    // Not injected: invisible. This is exactly why the process patch exists.
    writeFileSync(join(skillsDir, "direct.md"), "x");
    expect(scope.violations).toHaveLength(1);
    expect(existsSync(join(skillsDir, "direct.md"))).toBe(true);
  });

  it("forwards allowed writes to the filesystem underneath", async () => {
    const guard = createWriteGuard({ scope: { installHome, paseoHome } });
    await guard.fs.mkdir(join(installHome, "backups"), { recursive: true, mode: 0o700 });
    await guard.fs.writeFile(join(installHome, "backups", "note.txt"), "hi", { mode: 0o600 });

    expect(readFileSync(join(installHome, "backups", "note.txt"), "utf8")).toBe("hi");
    expect(guard.violations).toHaveLength(0);
    expect(guard.paths()).toEqual([
      join(installHome, "backups"),
      join(installHome, "backups", "note.txt"),
    ]);
  });

  it("can record instead of block, and can be reset", async () => {
    const guard = createWriteGuard({ scope: { installHome, paseoHome }, mode: "record" });
    await guard.fs.writeFile(join(skillsDir, "recorded.md"), "x");

    expect(existsSync(join(skillsDir, "recorded.md"))).toBe(true);
    expect(guard.violations).toHaveLength(1);

    guard.reset();
    expect(guard.violations).toHaveLength(0);
    expect(guard.writes).toHaveLength(0);
  });
});
