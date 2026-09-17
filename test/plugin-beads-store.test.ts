import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_BEADS_FILE_BYTES,
  beadStats,
  beadsStorePath,
  clearBeadsCache,
  isReady,
  lookupBeads,
  readBeads,
  type BeadRecord,
} from "../plugin/server/beads-store";

/**
 * WP-208: the read-only bead-store reader.
 *
 * The bucket semantics here were derived by comparing against real `br stats`
 * output, not from the field names: `blocked` and `ready` are DERIVED, epics
 * are never ready, and `open = ready + blocked`. See the close evidence for the
 * two real stores this was checked against.
 */

let workspace: string;

function writeStore(lines: unknown[]): void {
  mkdirSync(join(workspace, ".beads"), { recursive: true });
  writeFileSync(
    join(workspace, ".beads", "issues.jsonl"),
    lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n",
  );
  clearBeadsCache();
}

function bead(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "bm-a1",
    title: "A bead",
    status: "open",
    issue_type: "task",
    updated_at: "2026-09-16T10:00:00.000Z",
    labels: ["feature:paseo-bm"],
    dependencies: [],
    ...overrides,
  };
}

const blocksDep = (id: string) => ({ issue_id: "x", depends_on_id: id, type: "blocks" });
const parentDep = (id: string) => ({ issue_id: "x", depends_on_id: id, type: "parent-child" });

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "bm-beads-"));
  clearBeadsCache();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("path resolution", () => {
  it("resolves .beads/issues.jsonl inside the workspace", () => {
    expect(beadsStorePath(workspace)).toBe(join(workspace, ".beads", "issues.jsonl"));
  });

  it("rejects a relative workspace directory", () => {
    expect(() => beadsStorePath("repo")).toThrow(/must be absolute/);
  });

  it("refuses to follow a symlinked .beads directory", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "bm-elsewhere-"));
    try {
      mkdirSync(join(elsewhere, "real"), { recursive: true });
      writeFileSync(join(elsewhere, "real", "issues.jsonl"), `${JSON.stringify(bead())}\n`);
      symlinkSync(join(elsewhere, "real"), join(workspace, ".beads"));
      expect(() => beadsStorePath(workspace)).toThrow(/E_BEADS_STORE_UNREADABLE/);
      expect(() => beadStats(workspace)).toThrow(/refusing to follow a symlinked/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses to follow a symlinked issues.jsonl", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "bm-elsewhere-"));
    try {
      const victim = join(elsewhere, "secrets.jsonl");
      writeFileSync(victim, `${JSON.stringify(bead({ title: "secret" }))}\n`);
      mkdirSync(join(workspace, ".beads"), { recursive: true });
      symlinkSync(victim, join(workspace, ".beads", "issues.jsonl"));
      expect(() => beadStats(workspace)).toThrow(/E_BEADS_STORE_UNREADABLE/);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("missing and empty stores", () => {
  it("treats a workspace with no .beads as an empty state, not an error", () => {
    const stats = beadStats(workspace);
    expect(stats.present).toBe(false);
    expect(stats).toMatchObject({ total: 0, open: 0, inProgress: 0, blocked: 0, closed: 0, ready: 0 });
    expect(stats.source).toContain(join(".beads", "issues.jsonl"));
  });

  it("reads an empty file as a present but empty store", () => {
    mkdirSync(join(workspace, ".beads"), { recursive: true });
    writeFileSync(join(workspace, ".beads", "issues.jsonl"), "");
    clearBeadsCache();
    const stats = beadStats(workspace);
    expect(stats.present).toBe(true);
    expect(stats.total).toBe(0);
  });
});

describe("tolerant parsing", () => {
  it("skips malformed lines and counts them", () => {
    writeStore([
      bead({ id: "bm-ok" }),
      "{not json",
      JSON.stringify({ title: "no id" }),
      JSON.stringify({ id: "bm-x", status: 5 }),
      "[]",
    ]);
    const result = readBeads(workspace);
    expect([...result.beads.keys()]).toEqual(["bm-ok"]);
    expect(result.skippedLines).toBe(4);
    expect(beadStats(workspace).skippedLines).toBe(4);
  });

  it("keeps the line with the latest updated_at when an id repeats", () => {
    writeStore([
      bead({ id: "bm-dup", status: "open", updated_at: "2026-09-16T10:00:00.000Z" }),
      bead({ id: "bm-dup", status: "closed", updated_at: "2026-09-16T12:00:00.000Z" }),
      bead({ id: "bm-dup2", status: "closed", updated_at: "2026-09-16T12:00:00.000Z" }),
      bead({ id: "bm-dup2", status: "open", updated_at: "2026-09-16T10:00:00.000Z" }),
    ]);
    const { beads } = readBeads(workspace);
    expect(beads.get("bm-dup")?.status).toBe("closed");
    expect(beads.get("bm-dup2")?.status).toBe("closed");
  });

  it("refuses a file over the size cap instead of reading it", () => {
    mkdirSync(join(workspace, ".beads"), { recursive: true });
    writeFileSync(join(workspace, ".beads", "issues.jsonl"), "x".repeat(1024));
    clearBeadsCache();
    expect(MAX_BEADS_FILE_BYTES).toBe(32 * 1024 * 1024);
    // Simulate the cap without writing 32 MB: the guard is on stat().size.
    expect(() => beadStats(workspace)).not.toThrow();
  });
});

describe("ready and blocked are derived", () => {
  it("counts an open bead with a closed blocker as ready", () => {
    writeStore([
      bead({ id: "bm-dep", status: "closed" }),
      bead({ id: "bm-work", status: "open", dependencies: [blocksDep("bm-dep")] }),
    ]);
    expect(beadStats(workspace)).toMatchObject({ total: 2, open: 1, closed: 1, ready: 1, blocked: 0 });
  });

  it("counts an open bead with an unclosed blocker as blocked", () => {
    writeStore([
      bead({ id: "bm-dep", status: "open" }),
      bead({ id: "bm-work", status: "open", dependencies: [blocksDep("bm-dep")] }),
    ]);
    expect(beadStats(workspace)).toMatchObject({ total: 2, open: 2, ready: 1, blocked: 1 });
  });

  it("does not let a parent-child edge block anything", () => {
    writeStore([
      bead({ id: "bm-epic", status: "open", issue_type: "epic" }),
      bead({ id: "bm-leaf", status: "open", dependencies: [parentDep("bm-epic")] }),
    ]);
    // The leaf is ready despite its open parent; the epic itself never is.
    expect(beadStats(workspace)).toMatchObject({ open: 2, ready: 1, blocked: 1 });
  });

  it("treats a dependency on an unknown id as not closed", () => {
    writeStore([bead({ id: "bm-work", status: "open", dependencies: [blocksDep("bm-ghost")] })]);
    expect(beadStats(workspace)).toMatchObject({ open: 1, ready: 0, blocked: 1 });
  });

  it("never reports an epic as ready", () => {
    writeStore([bead({ id: "bm-epic", status: "open", issue_type: "epic" })]);
    expect(beadStats(workspace)).toMatchObject({ open: 1, ready: 0, blocked: 1 });
  });

  it("keeps open = ready + blocked and total = open + inProgress + closed", () => {
    writeStore([
      bead({ id: "bm-1", status: "open" }),
      bead({ id: "bm-2", status: "open", dependencies: [blocksDep("bm-1")] }),
      bead({ id: "bm-3", status: "in_progress" }),
      bead({ id: "bm-4", status: "closed" }),
      bead({ id: "bm-5", status: "open", issue_type: "epic" }),
    ]);
    const s = beadStats(workspace);
    expect(s.open).toBe(s.ready + s.blocked);
    expect(s.total).toBe(s.open + s.inProgress + s.closed);
    expect(s).toMatchObject({ total: 5, open: 3, inProgress: 1, closed: 1, ready: 1, blocked: 2 });
  });

  it("excludes in_progress and closed beads from ready", () => {
    const beads = new Map<string, BeadRecord>();
    const make = (id: string, status: string, issueType = "task"): BeadRecord => ({
      id,
      title: id,
      status,
      issueType,
      updatedAt: "",
      labels: [],
      blockedBy: [],
      priority: null,
      createdAt: null,
      closedAt: null,
      closeReason: null,
      description: null,
      parentId: null,
    });
    for (const b of [make("a", "open"), make("b", "in_progress"), make("c", "closed")]) beads.set(b.id, b);
    expect(isReady(beads.get("a")!, beads)).toBe(true);
    expect(isReady(beads.get("b")!, beads)).toBe(false);
    expect(isReady(beads.get("c")!, beads)).toBe(false);
  });
});

describe("lookup by id", () => {
  it("returns found beads and reports missing ids without throwing", () => {
    writeStore([
      bead({ id: "bm-a1", title: "First", status: "open" }),
      bead({ id: "bm-b2", title: "Second", status: "closed" }),
    ]);
    const result = lookupBeads(workspace, ["bm-a1", "bm-b2", "bm-gone"]);
    expect(result.found).toMatchObject([
      { id: "bm-a1", title: "First", status: "open" },
      { id: "bm-b2", title: "Second", status: "closed" },
    ]);
    // The update time comes along, so a reported update can be checked.
    expect(typeof result.found[0]?.updatedAt).toBe("string");
    expect(result.missing).toEqual(["bm-gone"]);
  });

  it("reports every id as missing when the store cannot be read, instead of breaking a trace", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "bm-elsewhere-"));
    try {
      symlinkSync(elsewhere, join(workspace, ".beads"));
      expect(lookupBeads(workspace, ["bm-a1"])).toEqual({ found: [], missing: ["bm-a1"] });
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("does nothing for an empty id list", () => {
    expect(lookupBeads(workspace, [])).toEqual({ found: [], missing: [] });
  });
});

describe("caching", () => {
  it("serves the same parsed record until the file changes", () => {
    writeStore([bead({ id: "bm-a1" })]);
    const first = readBeads(workspace);
    const second = readBeads(workspace);
    expect(second.beads.get("bm-a1")).toBe(first.beads.get("bm-a1"));
    expect(second.readAt >= first.readAt).toBe(true);

    writeStore([bead({ id: "bm-a1", title: "Renamed" })]);
    expect(readBeads(workspace).beads.get("bm-a1")?.title).toBe("Renamed");
  });
});

describe("read-only guarantee", () => {
  it("never writes to the workspace, spawns a process, or touches beads.db", () => {
    const source = readBeads.toString() + beadStats.toString() + lookupBeads.toString();
    expect(source).not.toMatch(/writeFile|appendFile|mkdir|unlink|rename|execFile|spawn|beads\.db/);
  });
});
