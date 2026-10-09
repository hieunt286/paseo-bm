import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_ACTIVE_MEMORY,
  MAX_MEMORY_SOURCE,
  MAX_MEMORY_TEXT,
  MAX_REMOVED_MEMORY,
  MEMORY_DIR_NAME,
  MEMORY_FULL_REASON,
  MEMORY_ID_PATTERN,
  capMemory,
  createMemoryStore,
  newMemoryId,
  type MemoryEntry,
  type NewMemoryEntry,
} from "../plugin/server/memory-store";
import { clearJsonFileCache } from "../plugin/server/data-files";
import { CLEANUP_DELETES } from "../plugin/server/setup-machine";
import { dataFolder, removeDataFolders } from "./helpers/data-folder";
import { fillMemory } from "./helpers/memory";

/** Project memory (missions design §2.5). Temporary data folders only. */

const WS = "wks_a";
const T0 = new Date("2026-10-09T10:00:00.000Z");
const SECRET = "memory-secret-42";

afterEach(() => {
  clearJsonFileCache();
  removeDataFolders();
});

function ids(): () => string {
  let n = 0;
  return () => `mem-${(++n).toString(16).padStart(10, "0")}`;
}

function store(home: string) {
  return createMemoryStore(home, { now: () => T0, newId: ids(), env: { PASEO_PASSWORD: SECRET } });
}

const main: MemoryEntry["by"] = { role: "main", agentId: "main-1", missionId: "mis-0000000001" };
const plugin: MemoryEntry["by"] = { role: "plugin", agentId: null, missionId: null };

function entry(overrides: Partial<NewMemoryEntry> = {}): NewMemoryEntry {
  return { kind: "fact", text: "The API listens on 8080.", source: "README.md", by: main, ...overrides };
}

function added(result: ReturnType<ReturnType<typeof store>["add"]>): MemoryEntry {
  if (!result.ok) throw new Error(result.reasons.join("\n"));
  return result.entry;
}

describe("project memory (§2.5)", () => {
  it("creates nothing on a read and writes { schemaVersion: 1, entries } 0600 per repo", () => {
    const home = dataFolder();
    const memory = store(home);
    expect(memory.list(WS)).toEqual([]);
    expect(existsSync(join(home, MEMORY_DIR_NAME))).toBe(false);
    const made = added(memory.add(WS, entry()));
    expect(made).toEqual({ id: "mem-0000000001", kind: "fact", text: "The API listens on 8080.", source: "README.md", by: main, at: T0.toISOString(), supersedes: null, state: "active" });
    expect(newMemoryId()).toMatch(MEMORY_ID_PATTERN);
    const path = join(home, MEMORY_DIR_NAME, `${WS}.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, MEMORY_DIR_NAME)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ schemaVersion: 1, entries: [made] });
    expect(memory.list("wks_b")).toEqual([]);
  });

  it("masks and bounds text and source", () => {
    const home = dataFolder();
    const made = added(store(home).add(WS, entry({ text: `${SECRET} ${"t".repeat(2000)}`, source: `${SECRET} ${"s".repeat(500)}` })));
    expect(made.text).not.toContain(SECRET);
    expect(made.text).toHaveLength(MAX_MEMORY_TEXT);
    expect(made.source).toHaveLength(MAX_MEMORY_SOURCE);
  });

  it("removes an entry and supersedes one in the same write", () => {
    const home = dataFolder();
    const memory = store(home);
    const first = added(memory.add(WS, entry()));
    const second = added(memory.add(WS, entry({ text: "The API listens on 9090.", supersedes: first.id })));
    expect(memory.active(WS).map((found) => found.id)).toEqual([second.id]);
    expect(memory.list(WS)[0]?.state).toBe("removed");
    expect(memory.add(WS, entry({ supersedes: first.id })).ok).toBe(false);
    expect(memory.remove(WS, second.id).ok).toBe(true);
    expect(memory.remove(WS, second.id)).toEqual({ ok: false, reasons: [`memory entry ${second.id} is not an active entry of this project`] });
    expect(memory.active(WS)).toEqual([]);
  });

  it("refuses an agent's add past the bound, and lets an automatic decision replace the oldest automatic one", () => {
    const home = dataFolder();
    const memory = store(home);
    const firstAuto = added(memory.add(WS, entry({ kind: "decision", by: plugin, text: "auto 0" })));
    added(memory.add(WS, entry({ kind: "decision", by: plugin, text: "auto 1" })));
    fillMemory(home, WS, MAX_ACTIVE_MEMORY - 2, (n) => ({ ...entry({ text: `fact ${n + 2}` }), at: T0.toISOString() }));
    expect(memory.active(WS)).toHaveLength(MAX_ACTIVE_MEMORY);
    expect(memory.add(WS, entry({ text: "one more" }))).toEqual({ ok: false, reasons: [MEMORY_FULL_REASON] });
    expect(MEMORY_FULL_REASON).toContain("curate the memory first (bm_memory remove)");

    added(memory.add(WS, entry({ kind: "decision", by: plugin, text: "auto new" })));
    const active = memory.active(WS);
    expect(active).toHaveLength(MAX_ACTIVE_MEMORY);
    expect(active.some((found) => found.id === firstAuto.id)).toBe(false);
    expect(active.at(-1)?.text).toBe("auto new");
  });

  it("keeps the newest removed entries only", () => {
    const at = (n: number) => new Date(T0.getTime() + n * 1000).toISOString();
    const removed = Array.from({ length: MAX_REMOVED_MEMORY + 5 }, (_, n): MemoryEntry => ({
      id: `mem-${n.toString(16).padStart(10, "0")}`,
      kind: "fact",
      text: `t${n}`,
      source: "s",
      by: main,
      at: at(n),
      supersedes: null,
      state: "removed",
    }));
    const kept = capMemory([...removed, { ...removed[0]!, id: "mem-ffffffffff", state: "active" }]);
    expect(kept).toHaveLength(MAX_REMOVED_MEMORY + 1);
    expect(kept[0]?.text).toBe("t5");
  });

  it("refuses a workspace id that is not a file name", () => {
    const home = dataFolder();
    expect(() => store(home).add("..", entry())).toThrow();
    expect(store(home).list("..")).toEqual([]);
  });

  it("is deleted by the cleanup", () => {
    expect(CLEANUP_DELETES).toContain(MEMORY_DIR_NAME);
  });
});
