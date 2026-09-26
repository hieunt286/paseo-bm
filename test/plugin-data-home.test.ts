import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DATA_HOME_ENV_VAR,
  DataHomeError,
  ensureDataHome,
  resolveDataHome,
  unsafeDataHomeReason,
  type DataHomeDeps,
} from "../plugin/server/data-home";

/**
 * WP-401: finding and creating the plugin's data folder without `install.json`
 * and without a Paseo handle (design §5.1, §5.2).
 *
 * Resolution runs against a fake environment and a spying `readFileSync`, so
 * the tests can also prove what is *never* read. Creation runs against a real
 * temporary HOME, because 0700 and the symlink refusal are properties of the
 * filesystem and a fake would only prove the fake.
 */

let home: string;
let paseoBm: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-data-home-"));
  paseoBm = join(home, ".paseo-bm");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Resolution deps with an empty environment and a `readFileSync` that records every path. */
function deps(env: Record<string, string | undefined> = {}): DataHomeDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    env,
    homedir: () => home,
    readFileSync(path: string, encoding: "utf8") {
      reads.push(path);
      return readFileSync(path, encoding);
    },
  };
}

function writePointer(value: unknown): void {
  mkdirSync(paseoBm, { recursive: true });
  writeFileSync(join(paseoBm, "home.json"), typeof value === "string" ? value : JSON.stringify(value));
}

const pointerTo = (target: string) => ({
  schemaVersion: 1,
  home: target,
  writtenBy: "paseo-bm@0.4.0",
  at: "2026-09-25T00:00:00.000Z",
});

describe("resolveDataHome", () => {
  it("uses PASEO_BM_HOME when it is absolute", () => {
    const custom = join(home, "elsewhere");
    const result = resolveDataHome(deps({ [DATA_HOME_ENV_VAR]: custom }));

    expect(result).toEqual({ home: custom, tracesDir: join(custom, "traces"), source: "env" });
  });

  it("refuses a relative PASEO_BM_HOME with a reason and no fallback", () => {
    const result = resolveDataHome(deps({ [DATA_HOME_ENV_VAR]: "relative/bm" }));

    expect(result.home).toBeNull();
    expect(result.tracesDir).toBeNull();
    expect("reason" in result && result.reason).toContain("absolute path");
  });

  it("ignores an empty PASEO_BM_HOME and falls through to the default", () => {
    const result = resolveDataHome(deps({ [DATA_HOME_ENV_VAR]: "   " }));

    expect(result).toEqual({ home: paseoBm, tracesDir: join(paseoBm, "traces"), source: "default" });
  });

  it("follows the pointer when there is no environment override", () => {
    const custom = join(home, "custom-bm");
    writePointer(pointerTo(custom));

    const result = resolveDataHome(deps());

    expect(result).toEqual({ home: custom, tracesDir: join(custom, "traces"), source: "pointer" });
  });

  it("prefers the environment over the pointer", () => {
    writePointer(pointerTo(join(home, "custom-bm")));
    const fromEnv = join(home, "from-env");

    const result = resolveDataHome(deps({ [DATA_HOME_ENV_VAR]: fromEnv }));

    expect(result).toMatchObject({ home: fromEnv, source: "env" });
  });

  it("resolves a pointer that names ~/.paseo-bm as the default", () => {
    writePointer(pointerTo(paseoBm));

    const result = resolveDataHome(deps());

    expect(result).toEqual({ home: paseoBm, tracesDir: join(paseoBm, "traces"), source: "default" });
  });

  it("uses ~/.paseo-bm when there is neither an override nor a pointer", () => {
    const result = resolveDataHome(deps());

    expect(result).toEqual({ home: paseoBm, tracesDir: join(paseoBm, "traces"), source: "default" });
  });

  it("does not need the data folder to exist", () => {
    const result = resolveDataHome(deps());

    expect(result.home).toBe(paseoBm);
    expect(() => statSync(paseoBm)).toThrow();
  });

  it("never reads install.json, and resolves with none anywhere", () => {
    const withRecord = deps();
    writePointer(pointerTo(join(home, "custom-bm")));

    const result = resolveDataHome(withRecord);

    expect(result).toMatchObject({ source: "pointer" });
    expect(withRecord.reads).toEqual([join(paseoBm, "home.json")]);
    expect(withRecord.reads.some((path) => path.endsWith("install.json"))).toBe(false);
  });

  for (const [label, contents] of [
    ["not JSON", "{ not json"],
    ["schemaVersion 2", JSON.stringify({ ...pointerTo("/opt/bm"), schemaVersion: 2 })],
    ["no schemaVersion", JSON.stringify({ home: "/opt/bm" })],
    ["a relative home", JSON.stringify({ schemaVersion: 1, home: "relative/bm" })],
    ["no home", JSON.stringify({ schemaVersion: 1 })],
    ["an empty home", JSON.stringify({ schemaVersion: 1, home: "   " })],
    ["an array", JSON.stringify([{ schemaVersion: 1, home: "/opt/bm" }])],
  ] as const) {
    it(`refuses a pointer that is ${label}, with no fallback`, () => {
      writePointer(contents);

      const result = resolveDataHome(deps());

      expect(result.home).toBeNull();
      expect(result.tracesDir).toBeNull();
      expect("reason" in result && result.reason).toContain("home.json");
    });
  }

  it("refuses an unsafe target named by the pointer", () => {
    writePointer(pointerTo(join(home, ".paseo", "bm")));

    const result = resolveDataHome(deps());

    expect(result.home).toBeNull();
    expect("reason" in result && result.reason).toContain("Paseo home");
  });
});

describe("unsafeDataHomeReason", () => {
  const env = {} as Record<string, string | undefined>;

  it("accepts a folder inside $HOME that overlaps nothing", () => {
    expect(unsafeDataHomeReason(join(home, ".paseo-bm"), home, env)).toBeNull();
    expect(unsafeDataHomeReason("/opt/bm-home", home, env)).toBeNull();
  });

  it("refuses $HOME itself and anything containing it", () => {
    expect(unsafeDataHomeReason(home, home, env)).toContain("home directory");
    expect(unsafeDataHomeReason(join(home, ".."), home, env)).toContain("home directory");
  });

  for (const dirName of [".paseo", ".claude", ".codex", ".agents"]) {
    it(`refuses ~/${dirName}, a folder inside it, and a folder containing it`, () => {
      expect(unsafeDataHomeReason(join(home, dirName), home, env)).toContain("overlaps");
      expect(unsafeDataHomeReason(join(home, dirName, "bm"), home, env)).toContain("overlaps");
    });
  }

  for (const [envVar, label] of [
    ["PASEO_HOME", "Paseo home"],
    ["CLAUDE_CONFIG_DIR", "Claude Code home"],
    ["CODEX_HOME", "Codex home"],
  ] as const) {
    it(`refuses a target inside ${envVar}`, () => {
      const moved = join(home, "moved", envVar.toLowerCase());

      expect(unsafeDataHomeReason(join(moved, "bm"), home, { [envVar]: moved })).toContain(label);
      expect(unsafeDataHomeReason(moved, home, { [envVar]: moved })).toContain(label);
    });
  }

  it("ignores a relative override rather than resolving it against the wrong base", () => {
    expect(unsafeDataHomeReason("/opt/bm-home", home, { PASEO_HOME: "relative/paseo" })).toBeNull();
  });
});

describe("ensureDataHome", () => {
  it("creates the folder with mode 0700", () => {
    const created = ensureDataHome(paseoBm, { homedir: () => home });

    expect(created).toBe(paseoBm);
    expect(statSync(paseoBm).isDirectory()).toBe(true);
    expect(statSync(paseoBm).mode & 0o777).toBe(0o700);
  });

  it("creates missing parents and is safe to call twice", () => {
    const nested = join(home, "a", "b", "bm");

    ensureDataHome(nested, { homedir: () => home });
    ensureDataHome(nested, { homedir: () => home });

    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });

  it("refuses a symlink partway down the path", () => {
    const real = join(home, "real");
    mkdirSync(real);
    symlinkSync(real, join(home, "link"));

    expect(() => ensureDataHome(join(home, "link", "bm"), { homedir: () => home })).toThrow(DataHomeError);
    expect(() => ensureDataHome(join(home, "link", "bm"), { homedir: () => home })).toThrow(/symlinked path/);
  });

  it("refuses a symlink standing where the data folder should be", () => {
    const real = join(home, "real");
    mkdirSync(real);
    symlinkSync(real, paseoBm);

    expect(() => ensureDataHome(paseoBm, { homedir: () => home })).toThrow(/symlinked path/);
  });

  it("refuses a relative path", () => {
    expect(() => ensureDataHome("relative/bm", { homedir: () => home })).toThrow(/absolute path/);
  });

  it("reports a folder it cannot create", () => {
    const file = join(home, "in-the-way");
    writeFileSync(file, "not a directory");

    expect(() => ensureDataHome(join(file, "bm"), { homedir: () => home })).toThrow(/cannot create/);
  });
});

describe("a symlinked $HOME", () => {
  it("does not stop the data folder being created", () => {
    // A home relocated to another mount: `$HOME` is a symlink to the real one.
    // Review b1: probing the walk's root for symlinks made the data folder —
    // and with it the trace store, the setup state and the cleanup mark —
    // permanently uncreatable on such a machine.
    const real = join(home, "real-home");
    const linked = join(home, "linked-home");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, linked);

    const created = ensureDataHome(join(linked, ".paseo-bm"), { homedir: () => linked });

    expect(statSync(created).isDirectory()).toBe(true);
    expect(statSync(created).mode & 0o777).toBe(0o700);
    // And a symlink below the root is still refused.
    symlinkSync(real, join(real, "link"));
    expect(() => ensureDataHome(join(linked, "link", "bm"), { homedir: () => linked })).toThrow(/symlinked path/);
  });
});
