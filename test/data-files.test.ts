import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DATA_DIR_MODE,
  DATA_FILE_MODE,
  appendToFile,
  assertNoSymlink,
  capBy,
  createJsonFileStore,
  ensureDataDir,
  entriesOf,
  keyedEntriesOf,
  writeFileAtomically,
  type JsonFileStoreOptions,
} from "../plugin/server/data-files";
import { firstSymlinkBelow } from "../plugin/server/data-home";

/**
 * `data-files.ts`: the safe files every store in the data folder writes
 * through, and the JSON store factory (code review 2026-09-30 §3.1). Runs
 * against a real temporary folder: a symlink cannot be faked.
 */

const CODE = "E_ORCHESTRATOR_WRITE_FAILED" as const;
const TOO_NEW = "E_DECISION_WRITE_FAILED" as const;

let root: string;
let home: string;
let outside: string;

const modeOf = (path: string): number => statSync(path).mode & 0o777;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-data-files-"));
  // Not created: every store must work on a data folder no write made yet.
  home = join(root, "data");
  outside = join(root, "outside");
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("firstSymlinkBelow: the one symlink walk", () => {
  it("finds nothing on a plain path, and stops at the first component that does not exist", () => {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    expect(firstSymlinkBelow(root, join(root, "a", "b"))).toBeNull();
    expect(firstSymlinkBelow(root, join(root, "a", "missing", "deeper", "file"))).toBeNull();
    expect(firstSymlinkBelow(root, root)).toBeNull();
  });

  it("names the first symlinked component below the root, without following it", () => {
    mkdirSync(join(root, "a"));
    symlinkSync(outside, join(root, "a", "link"));
    expect(firstSymlinkBelow(root, join(root, "a", "link", "file.json"))).toBe(join(root, "a", "link"));
  });

  it("never judges the root itself: a home on another mount is a symlink on plenty of machines", () => {
    const linkedRoot = join(root, "linked-root");
    symlinkSync(outside, linkedRoot);
    expect(firstSymlinkBelow(linkedRoot, join(linkedRoot, "file"))).toBeNull();
  });

  it("ends at a regular file standing in the path (ENOTDIR): nothing can exist below it", () => {
    writeFileSync(join(root, "plain"), "a file");
    expect(firstSymlinkBelow(root, join(root, "plain", "below", "file"))).toBeNull();
  });

  it("refuses a target outside the root", () => {
    expect(() => firstSymlinkBelow(join(root, "a"), join(root, "b"))).toThrow(/is not inside/);
  });
});

describe("the file helpers, keyed on the data folder", () => {
  it("judge the data folder itself, with the caller's code", () => {
    symlinkSync(outside, home);
    expect(() => assertNoSymlink(home, join(home, "x.json"), CODE)).toThrow(/^E_ORCHESTRATOR_WRITE_FAILED: refusing to use a symlinked path/);
    expect(() => ensureDataDir(home, join(home, "sub"), "E_TRACE_STORE_UNWRITABLE")).toThrow(/^E_TRACE_STORE_UNWRITABLE: /);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("create the data folder and the folder inside it 0700, and files 0600", () => {
    ensureDataDir(home, join(home, "sub", "deeper"), CODE);
    expect(modeOf(home)).toBe(DATA_DIR_MODE);
    expect(modeOf(join(home, "sub"))).toBe(DATA_DIR_MODE);
    expect(modeOf(join(home, "sub", "deeper"))).toBe(DATA_DIR_MODE);
    writeFileAtomically(home, join(home, "sub", "a.json"), "{}\n", CODE);
    appendToFile(join(home, "sub", "b.jsonl"), "{}\n", CODE);
    expect(modeOf(join(home, "sub", "a.json"))).toBe(DATA_FILE_MODE);
    expect(modeOf(join(home, "sub", "b.jsonl"))).toBe(DATA_FILE_MODE);
  });

  it("replace a file atomically: no temporary file left, and a failed write leaves the file as it was", () => {
    ensureDataDir(home, home, CODE);
    const path = join(home, "a.json");
    writeFileAtomically(home, path, "first\n", CODE);
    writeFileAtomically(home, path, "second\n", CODE);
    expect(readFileSync(path, "utf8")).toBe("second\n");
    expect(readdirSync(home)).toEqual(["a.json"]);
    // No temporary file can be created in a read-only folder: the write fails before the rename.
    chmodSync(home, 0o500);
    try {
      expect(() => writeFileAtomically(home, path, "third\n", CODE)).toThrow(/^E_ORCHESTRATOR_WRITE_FAILED: cannot create the temporary file/);
    } finally {
      chmodSync(home, 0o700);
    }
    expect(readFileSync(path, "utf8")).toBe("second\n");
  });

  it("refuse to append through a symlinked file (O_NOFOLLOW), leaving its target untouched", () => {
    ensureDataDir(home, home, CODE);
    const victim = join(outside, "victim.jsonl");
    writeFileSync(victim, "original\n");
    symlinkSync(victim, join(home, "log.jsonl"));
    expect(() => appendToFile(join(home, "log.jsonl"), "x\n", CODE)).toThrow(/^E_ORCHESTRATOR_WRITE_FAILED: cannot append/);
    expect(readFileSync(victim, "utf8")).toBe("original\n");
  });
});

describe("entriesOf, keyedEntriesOf, capBy", () => {
  const entry = z.object({ n: z.number() });

  it("skip a bad entry on its own, and read anything but the expected shape as none", () => {
    expect(entriesOf(entry, [{ n: 1 }, { n: "two" }, null, { n: 3 }])).toEqual([{ n: 1 }, { n: 3 }]);
    expect(entriesOf(entry, { n: 1 })).toEqual([]);
    expect(keyedEntriesOf(entry, { a: { n: 1 }, b: { n: "x" }, c: { n: 3 } }, (key) => key !== "c")).toEqual({ a: { n: 1 } });
    expect(keyedEntriesOf(entry, [{ n: 1 }])).toEqual({});
  });

  it("keep the order, dropping the lowest rank first and the earlier of a tie; without a rank, the first ones", () => {
    expect(capBy([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
    expect(capBy([5, 1, 4, 1, 3], 3, (n) => n)).toEqual([5, 4, 3]);
    expect(capBy(["open", "done", "open", "done"], 2, (s) => (s === "open" ? 1 : 0))).toEqual(["open", "open"]);
    expect(capBy([1, 2], 5)).toEqual([1, 2]);
  });
});

describe("createJsonFileStore", () => {
  const entrySchema = z.object({ id: z.string() });
  type Content = { entries: Array<{ id: string }> };

  const store = (over: Partial<JsonFileStoreOptions<Content>> = {}) =>
    createJsonFileStore<Content>({
      home,
      dir: "things",
      file: "things.json",
      version: 2,
      parse: (body) => ({ entries: entriesOf(entrySchema, body["entries"]) }),
      empty: () => ({ entries: [] }),
      codes: { unwritable: CODE, tooNew: TOO_NEW },
      ...over,
    });
  const path = () => join(home, "things", "things.json");
  const seed = (text: string) => {
    mkdirSync(join(home, "things"), { recursive: true });
    writeFileSync(path(), text);
  };

  it("reads a missing file as empty, and creates nothing on a read", () => {
    expect(store().inspect()).toEqual({ state: "missing", value: { entries: [] }, problem: null });
    expect(store().read()).toEqual({ entries: [] });
    expect(existsSync(home)).toBe(false);
  });

  it("reads a corrupt or unrecognised file as empty, and the next write replaces it", () => {
    for (const text of ["{ nope", "[1, 2]", JSON.stringify({ version: 1, entries: [{ id: "old" }] }), JSON.stringify({ entries: [{ id: "x" }] })]) {
      seed(text);
      const found = store().inspect();
      expect(found.state).toBe("unusable");
      expect(found.value).toEqual({ entries: [] });
    }
    expect(store().inspect().problem).toBe("version: expected 2, got null");
    seed("{ nope");
    expect(store().inspect().problem).toMatch(/^not JSON: /);
    store().write({ entries: [{ id: "new" }] });
    expect(store().read()).toEqual({ entries: [{ id: "new" }] });
  });

  it("skips an entry that does not validate on its own, and drops it at the next write", () => {
    seed(JSON.stringify({ version: 2, entries: [{ id: "a" }, { id: 7 }, { id: "c" }] }));
    expect(store().read()).toEqual({ entries: [{ id: "a" }, { id: "c" }] });
    store().update(({ entries }) => ({ entries: [...entries, { id: "d" }] }));
    expect(JSON.parse(readFileSync(path(), "utf8"))).toEqual({ version: 2, entries: [{ id: "a" }, { id: "c" }, { id: "d" }] });
  });

  it("reads a newer version as empty and never writes it: every write throws the tooNew code", () => {
    const newer = JSON.stringify({ version: 3, entries: [{ id: "from-the-future" }], more: true });
    seed(newer);
    const found = store().inspect();
    expect(found.state).toBe("too-new");
    expect(found.value).toEqual({ entries: [] });
    expect(found.problem).toMatch(/newer paseo-bm/);
    expect(() => store().readForWrite()).toThrow(/^E_DECISION_WRITE_FAILED: .* was written by a newer paseo-bm/);
    expect(() => store().write({ entries: [] })).toThrow(/^E_DECISION_WRITE_FAILED: /);
    expect(() => store().update(() => ({ entries: [] }))).toThrow(/^E_DECISION_WRITE_FAILED: /);
    // Without a tooNew code, the unwritable one.
    expect(() => store({ codes: { unwritable: CODE } }).write({ entries: [] })).toThrow(/^E_ORCHESTRATOR_WRITE_FAILED: /);
    expect(readFileSync(path(), "utf8")).toBe(newer);
  });

  it("creates the data folder and its own folder 0700 and the file 0600 on the first write, in the format every store writes", () => {
    const written = store().write({ entries: [{ id: "a" }] });
    expect(written).toEqual({ entries: [{ id: "a" }] });
    expect(modeOf(home)).toBe(DATA_DIR_MODE);
    expect(modeOf(join(home, "things"))).toBe(DATA_DIR_MODE);
    expect(modeOf(path())).toBe(DATA_FILE_MODE);
    expect(readFileSync(path(), "utf8")).toBe(`${JSON.stringify({ version: 2, entries: [{ id: "a" }] }, null, 2)}\n`);
  });

  it("writes a file in the data folder itself, with another version key", () => {
    const flat = createJsonFileStore<{ told: string[] }>({
      home,
      dir: "",
      file: "flat.json",
      version: 1,
      versionKey: "schemaVersion",
      parse: (body) => ({ told: Array.isArray(body["told"]) ? (body["told"] as string[]) : [] }),
      empty: () => ({ told: [] }),
      codes: { unwritable: CODE },
    });
    flat.write({ told: ["x"] });
    expect(JSON.parse(readFileSync(join(home, "flat.json"), "utf8"))).toEqual({ schemaVersion: 1, told: ["x"] });
    expect(flat.read()).toEqual({ told: ["x"] });
  });

  it("replaces the file atomically, leaving no temporary file", () => {
    const s = store();
    s.write({ entries: [{ id: "a" }] });
    s.write({ entries: [{ id: "b" }] });
    expect(readdirSync(join(home, "things"))).toEqual(["things.json"]);
    expect(s.read()).toEqual({ entries: [{ id: "b" }] });
  });

  it("applies the cap to every value written, and writes nothing when update's change returns null", () => {
    const s = store({ cap: ({ entries }) => ({ entries: capBy(entries, 2) }) });
    expect(s.write({ entries: [{ id: "a" }, { id: "b" }, { id: "c" }] })).toEqual({ entries: [{ id: "b" }, { id: "c" }] });
    expect(s.update(() => null)).toBeNull();
    expect(s.read()).toEqual({ entries: [{ id: "b" }, { id: "c" }] });
  });

  it("refuses a symlink on a read and on a write, with the unwritable code, leaving the target untouched", () => {
    const victim = join(outside, "things.json");
    writeFileSync(victim, JSON.stringify({ version: 2, entries: [{ id: "secret" }] }));
    mkdirSync(join(home, "things"), { recursive: true });
    symlinkSync(victim, path());
    expect(() => store().read()).toThrow(/^E_ORCHESTRATOR_WRITE_FAILED: refusing to use a symlinked path/);
    expect(() => store().write({ entries: [] })).toThrow(/^E_ORCHESTRATOR_WRITE_FAILED: refusing to use a symlinked path/);

    // A symlinked folder on the way, and the data folder itself.
    rmSync(join(home, "things"), { recursive: true });
    symlinkSync(outside, join(home, "things"));
    expect(() => store().write({ entries: [] })).toThrow(/symlinked path/);
    rmSync(home, { recursive: true });
    symlinkSync(outside, home);
    expect(() => store().write({ entries: [] })).toThrow(/symlinked path/);
    expect(readdirSync(outside)).toEqual(["things.json"]);
    expect(JSON.parse(readFileSync(victim, "utf8"))).toEqual({ version: 2, entries: [{ id: "secret" }] });
  });

  it("with keepUnusable, never overwrites a file it cannot use", () => {
    const strict = store({
      keepUnusable: true,
      parse: (body) => {
        const result = z.object({ entries: z.array(entrySchema) }).safeParse(body);
        if (!result.success) throw new Error("entries: not all valid");
        return result.data;
      },
    });
    const text = JSON.stringify({ version: 2, entries: [{ id: "a" }, { id: 7 }] });
    seed(text);
    expect(strict.inspect()).toEqual({ state: "unusable", value: { entries: [] }, problem: "entries: not all valid" });
    expect(() => strict.write({ entries: [] })).toThrow(/^E_ORCHESTRATOR_WRITE_FAILED: .* is not usable \(entries: not all valid\); it is left as it is/);
    expect(readFileSync(path(), "utf8")).toBe(text);
  });

  it("refuses a file name or folder that leaves the data folder", () => {
    expect(() => store({ file: "../escape.json" })).toThrow(/^E_ORCHESTRATOR_WRITE_FAILED: not a file inside the data folder/);
    expect(() => store({ file: "a/b.json" })).toThrow(/not a file inside the data folder/);
    expect(() => store({ dir: "../elsewhere" })).toThrow(/not a file inside the data folder/);
  });
});
