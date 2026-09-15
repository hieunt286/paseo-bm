import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  PathGuardError,
  assertNoSymlinkInPath,
  assertSafeWritePath,
  assertWithinRoot,
  containsPath,
  isWithinRoot,
  toAbsolutePath,
} from "../src/paths-guard.js";

describe("toAbsolutePath", () => {
  const cases: { name: string; input: string; cwd: string; homeDir: string; expected: string }[] = [
    {
      name: "keeps an absolute path",
      input: "/opt/paseo-bm",
      cwd: "/work",
      homeDir: "/home/u",
      expected: "/opt/paseo-bm",
    },
    {
      name: "resolves a relative path against cwd",
      input: "sub/dir",
      cwd: "/work",
      homeDir: "/home/u",
      expected: "/work/sub/dir",
    },
    {
      name: "expands a bare tilde",
      input: "~",
      cwd: "/work",
      homeDir: "/home/u",
      expected: "/home/u",
    },
    {
      name: "expands a tilde prefix",
      input: "~/.paseo-bm",
      cwd: "/work",
      homeDir: "/home/u",
      expected: "/home/u/.paseo-bm",
    },
    {
      name: "does not expand a tilde that is part of a name",
      input: "~backup/dir",
      cwd: "/work",
      homeDir: "/home/u",
      expected: "/work/~backup/dir",
    },
    {
      name: "normalises traversal segments",
      input: "/opt/a/../b",
      cwd: "/work",
      homeDir: "/home/u",
      expected: "/opt/b",
    },
    {
      name: "trims surrounding whitespace",
      input: "  /opt/paseo-bm  ",
      cwd: "/work",
      homeDir: "/home/u",
      expected: "/opt/paseo-bm",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(
        toAbsolutePath(testCase.input, { cwd: testCase.cwd, homeDir: testCase.homeDir }),
      ).toBe(testCase.expected);
    });
  }

  it("refuses an empty value", () => {
    expect(() => toAbsolutePath("   ", { cwd: "/work", homeDir: "/home/u" })).toThrowError(
      PathGuardError,
    );
    try {
      toAbsolutePath("", { cwd: "/work" });
      expect.unreachable("expected an empty path to be refused");
    } catch (error) {
      expect((error as PathGuardError).reason).toBe("empty-path");
    }
  });
});

describe("isWithinRoot", () => {
  const root = "/srv/install";
  const cases: { name: string; candidate: string; within: boolean }[] = [
    { name: "the root itself", candidate: "/srv/install", within: true },
    { name: "a direct child", candidate: "/srv/install/install.json", within: true },
    { name: "a deep child", candidate: "/srv/install/plugin/0.1.0/roles/worker.md", within: true },
    { name: "traversal that lands back inside", candidate: "/srv/install/a/../b", within: true },
    { name: "traversal that escapes one level", candidate: "/srv/install/../secrets", within: false },
    { name: "traversal that escapes to the filesystem root", candidate: "/srv/install/../../etc/passwd", within: false },
    { name: "a sibling sharing a name prefix", candidate: "/srv/install-other", within: false },
    { name: "the parent directory", candidate: "/srv", within: false },
    { name: "an unrelated absolute path", candidate: "/etc/passwd", within: false },
  ];

  for (const testCase of cases) {
    it(`${testCase.within ? "accepts" : "rejects"} ${testCase.name}`, () => {
      expect(isWithinRoot(root, testCase.candidate)).toBe(testCase.within);
      if (testCase.within) {
        expect(assertWithinRoot(root, testCase.candidate)).toBe(resolve(testCase.candidate));
      } else {
        expect(() => assertWithinRoot(root, testCase.candidate)).toThrowError(PathGuardError);
        try {
          assertWithinRoot(root, testCase.candidate);
          expect.unreachable("expected the path to be refused");
        } catch (error) {
          expect((error as PathGuardError).reason).toBe("outside-root");
          expect((error as PathGuardError).conflict).toBe(root);
        }
      }
    });
  }
});

describe("containsPath", () => {
  it("is strict: a directory does not contain itself", () => {
    expect(containsPath("/srv/install", "/srv/install")).toBe(false);
    expect(containsPath("/srv", "/srv/install")).toBe(true);
    expect(containsPath("/srv/install", "/srv")).toBe(false);
  });
});

describe("symlink guards", () => {
  let root: string;

  beforeEach(() => {
    // realpath because macOS puts temp dirs behind the /var -> /private/var symlink.
    root = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-guard-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts a path whose segments are all real directories", () => {
    mkdirSync(join(root, "plugin", "0.1.0"), { recursive: true });
    const target = join(root, "plugin", "0.1.0", "manifest.json");
    expect(assertNoSymlinkInPath(target, { root })).toBe(target);
    expect(assertSafeWritePath(root, target)).toBe(target);
  });

  it("accepts a path whose deeper segments do not exist yet", () => {
    const target = join(root, "backups", "20260915T101500Z", "paseo-config.json");
    expect(assertSafeWritePath(root, target)).toBe(target);
  });

  it("rejects a path whose final segment is a symlink", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-outside-")));
    const link = join(root, "install.json");
    writeFileSync(join(outside, "real.json"), "{}");
    symlinkSync(join(outside, "real.json"), link);

    try {
      assertSafeWritePath(root, link);
      expect.unreachable("expected the symlinked file to be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(PathGuardError);
      expect((error as PathGuardError).reason).toBe("symlink-in-path");
      expect((error as PathGuardError).conflict).toBe(link);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a path that travels through a symlinked directory", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "paseo-bm-outside-")));
    mkdirSync(join(outside, "plugin"), { recursive: true });
    symlinkSync(outside, join(root, "escape"));

    const target = join(root, "escape", "plugin", "0.1.0", "manifest.json");
    try {
      assertSafeWritePath(root, target);
      expect.unreachable("expected the path through a symlink to be refused");
    } catch (error) {
      expect((error as PathGuardError).reason).toBe("symlink-in-path");
      expect((error as PathGuardError).conflict).toBe(join(root, "escape"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a symlink loop without following it", () => {
    symlinkSync(join(root, "loop"), join(root, "loop"));
    expect(() => assertSafeWritePath(root, join(root, "loop", "file"))).toThrowError(
      /symlink/i,
    );
  });

  it("does not inspect the trusted root itself", () => {
    // `root` is resolved by the caller; a symlinked ancestor above it (such as
    // /var on macOS) must not make every write fail.
    const linkedRoot = join(realpathSync(tmpdir()), `paseo-bm-linked-${process.pid}`);
    symlinkSync(root, linkedRoot);
    try {
      const target = join(linkedRoot, "install.json");
      expect(assertNoSymlinkInPath(target, { root: linkedRoot })).toBe(target);
      expect(() => assertNoSymlinkInPath(target)).toThrowError(PathGuardError);
    } finally {
      rmSync(linkedRoot, { force: true });
    }
  });

  it("rejects an escaping path before it looks at the filesystem", () => {
    const target = resolve(root, `..${sep}elsewhere`);
    try {
      assertSafeWritePath(root, target);
      expect.unreachable("expected the escaping path to be refused");
    } catch (error) {
      expect((error as PathGuardError).reason).toBe("outside-root");
    }
  });
});
