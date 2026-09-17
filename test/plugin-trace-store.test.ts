import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_MESSAGE_CHARS,
  TRUNCATION_MARKER,
  appendRecord,
  capRecord,
  clearTraceStoreCache,
  dedupeRecords,
  ensureStore,
  countTraces,
  measureStore,
  monthlyFileName,
  monthlyFiles,
  readRecords,
  readStoreMeta,
  readWorkspaceMeta,
  withWorkspaceLock,
  writeWorkspaceMeta,
  type TraceStoreLocation,
} from "../plugin/server/trace-store";
import { TRACE_STORE_SCHEMA_VERSION, type TraceRecord } from "../plugin/shared/contracts";

/**
 * WP-203 part 2: persistence, tolerant reading, dedupe, metadata and sizing.
 *
 * Real temporary filesystem: the properties under test are "a killed process
 * loses only its own half-written line" and "a newer store is never written",
 * and neither can be shown against a fake fs.
 */

let home: string;
let location: TraceStoreLocation;
const WS = "wks_1";

function record(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    v: TRACE_STORE_SCHEMA_VERSION,
    kind: "turn",
    at: "2026-09-16T10:00:00.000Z",
    workspaceId: WS,
    agentId: "agent-worker",
    role: "worker",
    turnId: "turn-1",
    requestId: "req-20260916T100000Z",
    parentAgentId: "agent-manager",
    agentCreatedAt: "2026-09-16T09:59:00.000Z",
    startedAt: "2026-09-16T09:59:30.000Z",
    endedAt: "2026-09-16T10:00:00.000Z",
    outcome: "completed",
    sent: [],
    received: [],
    reports: [],
    reviews: [],
    evidence: [],
    usage: null,
    ...overrides,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bm-store2-"));
  location = { tracesDir: join(home, "traces") };
  clearTraceStoreCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("monthly file naming", () => {
  it("uses the UTC year and month of the record", () => {
    expect(monthlyFileName("2026-09-16T10:00:00.000Z")).toBe("events-202609.jsonl");
    expect(monthlyFileName("2026-12-31T23:59:59.000Z")).toBe("events-202612.jsonl");
    expect(monthlyFileName("2027-01-01T00:30:00.000Z")).toBe("events-202701.jsonl");
  });

  it("does not throw on an unparseable timestamp", () => {
    expect(monthlyFileName("not-a-date")).toBe("events-197001.jsonl");
  });
});

describe("append and read round trip", () => {
  it("writes one line per record and reads it back", async () => {
    await appendRecord(location, record());
    await appendRecord(location, record({ turnId: "turn-2", at: "2026-09-16T10:05:00.000Z" }));

    const path = join(location.tracesDir, WS, "events-202609.jsonl");
    expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toHaveLength(2);

    const result = readRecords(location, WS);
    expect(result.records.map((r) => r.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(result.skippedLines).toBe(0);
    expect(result.limitedRead).toBe(false);
  });

  it("keeps a report's incompleteFields and skillsUsed, and defaults them for records written before it existed (delta 20260917)", async () => {
    const report = {
      agentId: "agent-worker",
      at: "2026-09-16T10:00:00.000Z",
      requestId: "req-20260916T100000Z",
      phase: "finished" as const,
      tier: "Large" as const,
      filesChanged: [],
      beadsCreated: ["x-a"],
      beadsUpdated: [],
      beadsClosed: [],
      beadsReady: [],
      reviewFindingsOpen: null,
      buildAndTests: null,
      blockers: null,
      guardrail: null,
      unparsedFields: [],
      incompleteFields: ["beadsCreated"],
      skillsUsed: ["polishing-beads"],
    };
    await appendRecord(location, record({ reports: [report] }));
    const older: Record<string, unknown> = { ...report };
    delete older.incompleteFields;
    delete older.skillsUsed;
    const path = join(location.tracesDir, WS, "events-202609.jsonl");
    appendFileSync(path, `${JSON.stringify(record({ turnId: "turn-old", at: "2026-09-16T10:01:00.000Z", reports: [older as unknown as typeof report] }))}\n`);
    clearTraceStoreCache();

    const result = readRecords(location, WS);
    expect(result.skippedLines).toBe(0);
    const byTurn = new Map(result.records.map((r) => [r.turnId, r]));
    expect(byTurn.get("turn-1")?.reports[0]?.incompleteFields).toEqual(["beadsCreated"]);
    expect(byTurn.get("turn-1")?.reports[0]?.skillsUsed).toEqual(["polishing-beads"]);
    expect(byTurn.get("turn-old")?.reports[0]?.incompleteFields).toEqual([]);
    expect(byTurn.get("turn-old")?.reports[0]?.skillsUsed).toEqual([]);
  });

  it("stamps the store schema version once", async () => {
    await appendRecord(location, record());
    const meta = readStoreMeta(location);
    expect(meta.meta?.schemaVersion).toBe(TRACE_STORE_SCHEMA_VERSION);
    expect(meta.tooNew).toBe(false);
    const created = meta.meta?.createdAt;
    await appendRecord(location, record({ turnId: "turn-3" }));
    expect(readStoreMeta(location).meta?.createdAt).toBe(created);
  });

  it("creates store and workspace directories 0700 and files 0600", async () => {
    await appendRecord(location, record());
    expect(statSync(location.tracesDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(location.tracesDir, WS)).mode & 0o777).toBe(0o700);
    expect(statSync(join(location.tracesDir, WS, "events-202609.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(join(location.tracesDir, "meta.json")).mode & 0o777).toBe(0o600);
    writeWorkspaceMeta(location, WS, {
      lastKnownName: "paseo-bm",
      lastKnownDirectory: "/repo",
      lastSeenAt: "2026-09-16T10:00:00.000Z",
    });
    expect(statSync(join(location.tracesDir, WS, "meta.json")).mode & 0o777).toBe(0o600);
  });

  it("splits records across monthly files, newest first", async () => {
    await appendRecord(location, record({ at: "2026-08-01T10:00:00.000Z", turnId: "aug" }));
    await appendRecord(location, record({ at: "2026-09-01T10:00:00.000Z", turnId: "sep" }));
    expect(monthlyFiles(location, WS).map((p) => p.split("/").pop())).toEqual([
      "events-202609.jsonl",
      "events-202608.jsonl",
    ]);
    expect(readRecords(location, WS).records.map((r) => r.turnId)).toEqual(["aug", "sep"]);
  });

  it("stops reading once the record cap is reached", async () => {
    await appendRecord(location, record({ at: "2026-08-01T10:00:00.000Z", turnId: "aug" }));
    await appendRecord(location, record({ at: "2026-09-01T10:00:00.000Z", turnId: "sep" }));
    const limited = readRecords(location, WS, { maxRecords: 1 });
    expect(limited.records).toHaveLength(1);
    expect(limited.records[0]?.turnId).toBe("sep");
  });
});

describe("tolerant reading", () => {
  it("skips a malformed line and keeps the rest", async () => {
    await appendRecord(location, record());
    const path = join(location.tracesDir, WS, "events-202609.jsonl");
    appendFileSync(path, "{not json\n");
    appendFileSync(path, `${JSON.stringify({ v: 1, kind: "turn" })}\n`);
    await appendRecord(location, record({ turnId: "turn-2", at: "2026-09-16T10:06:00.000Z" }));

    clearTraceStoreCache();
    const result = readRecords(location, WS);
    expect(result.records.map((r) => r.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(result.skippedLines).toBe(2);
    expect(result.notices.join(" ")).toContain("Skipped 2 unreadable line(s)");
  });

  it("skips a truncated final line written by a killed process", async () => {
    await appendRecord(location, record());
    const path = join(location.tracesDir, WS, "events-202609.jsonl");
    const halfLine = JSON.stringify(record({ turnId: "turn-dead" })).slice(0, 40);
    appendFileSync(path, halfLine);

    clearTraceStoreCache();
    const result = readRecords(location, WS);
    expect(result.records.map((r) => r.turnId)).toEqual(["turn-1"]);
    expect(result.skippedLines).toBe(1);
  });

  it("caches by mtime and size, and invalidates after an append", async () => {
    await appendRecord(location, record());
    const first = readRecords(location, WS);
    const second = readRecords(location, WS);
    // Served from cache: the very same parsed record object comes back, which a
    // re-parse could not produce. (The array itself is rebuilt by dedupe.)
    expect(second.records[0]).toBe(first.records[0]);

    await appendRecord(location, record({ turnId: "turn-2", at: "2026-09-16T10:07:00.000Z" }));
    const third = readRecords(location, WS);
    expect(third.records[0]).not.toBe(first.records[0]);
    expect(third.records).toHaveLength(2);
  });

  it("returns nothing for a workspace with no directory", () => {
    expect(readRecords(location, "wks_unknown").records).toEqual([]);
  });
});

describe("dedupe", () => {
  it("keeps the latest record per agent and turn", () => {
    const early = record({ at: "2026-09-16T10:00:00.000Z", outcome: "canceled" });
    const late = record({ at: "2026-09-16T10:01:00.000Z", outcome: "completed" });
    expect(dedupeRecords([early, late])).toEqual([late]);
    expect(dedupeRecords([late, early])).toEqual([late]);
  });

  it("does not merge different agents or turns", () => {
    const a = record({ agentId: "a" });
    const b = record({ agentId: "b" });
    const c = record({ turnId: "turn-2", at: "2026-09-16T10:02:00.000Z" });
    expect(dedupeRecords([a, b, c])).toHaveLength(3);
  });

  it("keeps every record that has no turn id", () => {
    const one = record({ turnId: null, at: "2026-09-16T10:00:00.000Z" });
    const two = record({ turnId: null, at: "2026-09-16T10:01:00.000Z" });
    expect(dedupeRecords([one, two])).toHaveLength(2);
  });

  // Delta 20260917d defect B: Paseo reuses turn ids inside one agent. On the
  // owner's store the same Manager had `foreground-turn-1..3` twice, eight
  // minutes apart, and keying on `(agentId, turnId)` alone silently dropped the
  // earlier three — including the turn carrying the owner's own question.
  const said = (text: string, at: string) => ({ agentId: null, at, text, truncated: false });

  it("keeps two turns that reuse one turn id but said different things", () => {
    const first = record({
      at: "2026-09-17T04:22:00.000Z",
      sent: [said("check mr giúp tôi", "2026-09-17T04:19:29.000Z")],
    });
    const second = record({
      at: "2026-09-17T04:31:00.000Z",
      sent: [said("tiếp tục phần còn lại", "2026-09-17T04:27:10.000Z")],
    });
    const kept = dedupeRecords([first, second]);
    expect(kept).toHaveLength(2);
    expect(kept.map((r) => r.sent[0]?.text)).toEqual(["check mr giúp tôi", "tiếp tục phần còn lại"]);
  });

  it("still merges one turn written twice, keeping the later record", () => {
    const written = record({
      at: "2026-09-17T04:22:00.000Z",
      outcome: "canceled",
      sent: [said("check mr giúp tôi", "2026-09-17T04:19:29.000Z")],
    });
    const rewritten = record({
      at: "2026-09-17T05:00:00.000Z",
      outcome: "completed",
      sent: [said("check mr giúp tôi", "2026-09-17T04:19:29.000Z")],
    });
    expect(dedupeRecords([written, rewritten])).toEqual([rewritten]);
  });

  it("merges a rewrite even when the collector stamped it with the write time", () => {
    // The precise risk that made the time-based key unusable: when the
    // collector's refetch fails it stamps every message with `now()`
    // (collector.ts `endedAt`), so the same words come back with new times.
    const fromTimeline = record({
      at: "2026-09-17T04:22:00.000Z",
      sent: [said("check mr giúp tôi", "2026-09-17T04:19:29.000Z")],
      received: [said("BM-REPORT\nphase: received", "2026-09-17T04:20:00.000Z")],
    });
    const afterReload = record({
      at: "2026-09-17T09:00:00.000Z",
      sent: [said("check mr giúp tôi", "2026-09-17T09:00:00.000Z")],
      received: [said("BM-REPORT\nphase: received", "2026-09-17T09:00:00.000Z")],
    });
    expect(dedupeRecords([fromTimeline, afterReload])).toEqual([afterReload]);
  });

  it("falls back to the turn id alone when a record has no messages", () => {
    const early = record({ at: "2026-09-17T04:22:00.000Z", outcome: "canceled" });
    const late = record({ at: "2026-09-17T04:31:00.000Z", outcome: "completed" });
    expect(dedupeRecords([early, late])).toEqual([late]);
  });

  it("does not merge two turns whose messages only differ in how they split", () => {
    // Length-prefixing: "ab" + "c" must not fingerprint as "a" + "bc".
    const one = record({
      at: "2026-09-17T04:22:00.000Z",
      sent: [said("ab", "2026-09-17T04:19:00.000Z"), said("c", "2026-09-17T04:19:01.000Z")],
    });
    const two = record({
      at: "2026-09-17T04:31:00.000Z",
      sent: [said("a", "2026-09-17T04:27:00.000Z"), said("bc", "2026-09-17T04:27:01.000Z")],
    });
    expect(dedupeRecords([one, two])).toHaveLength(2);
  });
});

describe("text caps", () => {
  it("cuts an oversized message and marks it truncated", () => {
    const long = "x".repeat(MAX_MESSAGE_CHARS + 500);
    const capped = capRecord(
      record({ sent: [{ agentId: null, at: "2026-09-16T10:00:00.000Z", text: long, truncated: false }] }),
    );
    const message = capped.sent[0];
    expect(message?.truncated).toBe(true);
    expect(message?.text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(message?.text.length).toBe(MAX_MESSAGE_CHARS + TRUNCATION_MARKER.length);
  });

  it("shrinks further when the whole record is still too big, without dropping messages", () => {
    const many = Array.from({ length: 12 }, (_unused, index) => ({
      agentId: null,
      at: "2026-09-16T10:00:00.000Z",
      text: `${index}`.repeat(MAX_MESSAGE_CHARS),
      truncated: false,
    }));
    const capped = capRecord(record({ sent: many }));
    expect(capped.sent).toHaveLength(12);
    expect(JSON.stringify(capped).length).toBeLessThan(32 * 1024);
  });
});

describe("workspace metadata", () => {
  it("skips only a rewrite that says exactly the same thing", () => {
    const meta = {
      lastKnownName: "paseo-bm",
      lastKnownDirectory: "/repo",
      lastSeenAt: "2026-09-16T10:00:00.000Z",
    };
    ensureStore(location);
    writeWorkspaceMeta(location, WS, meta);
    const path = join(location.tracesDir, WS, "meta.json");
    const firstMtime = statSync(path).mtimeMs;

    // Identical in all three fields: nothing to write.
    writeWorkspaceMeta(location, WS, { ...meta });
    expect(statSync(path).mtimeMs).toBe(firstMtime);

    // WP-214 acceptance: the guard used to compare the name and directory
    // only, so `lastSeenAt` froze at the first turn — it read 06:42 for a
    // workspace that stayed busy until 07:35.
    writeWorkspaceMeta(location, WS, { ...meta, lastSeenAt: "2026-09-16T11:00:00.000Z" });
    expect(readWorkspaceMeta(location, WS)?.lastSeenAt).toBe("2026-09-16T11:00:00.000Z");
    expect(readWorkspaceMeta(location, WS)?.lastKnownDirectory).toBe("/repo");

    writeWorkspaceMeta(location, WS, { ...meta, lastKnownDirectory: "/moved" });
    expect(readWorkspaceMeta(location, WS)?.lastKnownDirectory).toBe("/moved");
  });

  it("returns null when a workspace has no metadata", () => {
    expect(readWorkspaceMeta(location, WS)).toBeNull();
  });
});

describe("a store written by a newer paseo-bm", () => {
  beforeEach(() => {
    mkdirSync(location.tracesDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(location.tracesDir, "meta.json"),
      JSON.stringify({ schemaVersion: TRACE_STORE_SCHEMA_VERSION + 1, createdAt: "x", updatedAt: "y" }),
      { mode: 0o600 },
    );
  });

  it("reads with a notice and refuses to write", async () => {
    const result = readRecords(location, WS);
    expect(result.limitedRead).toBe(true);
    expect(result.notices.join(" ")).toContain("newer than this plugin understands");

    await expect(appendRecord(location, record())).rejects.toThrow(/E_TRACE_STORE_SCHEMA_TOO_NEW/);
    expect(monthlyFiles(location, WS)).toEqual([]);
  });
});

describe("contained failures", () => {
  it("reports a permission failure as a coded error instead of crashing", async () => {
    mkdirSync(location.tracesDir, { recursive: true, mode: 0o700 });
    ensureStore(location);
    mkdirSync(join(location.tracesDir, WS), { recursive: true, mode: 0o700 });
    chmodSync(join(location.tracesDir, WS), 0o500);
    try {
      await expect(appendRecord(location, record())).rejects.toThrow(/E_TRACE_STORE_UNWRITABLE/);
    } finally {
      chmodSync(join(location.tracesDir, WS), 0o700);
    }
  });
});

describe("sizing", () => {
  it("measures bytes with stat and counts traces per workspace", async () => {
    await appendRecord(location, record());
    await appendRecord(location, record({ turnId: "turn-2", at: "2026-09-16T10:05:00.000Z" }));
    await appendRecord(location, record({ workspaceId: "wks_2", requestId: "req-other" }));

    const monthly = join(location.tracesDir, WS, "events-202609.jsonl");
    const size = measureStore(location, WS);
    expect(size.workspaceBytes).toBe(statSync(monthly).size);
    expect(size.bytes).toBeGreaterThan(size.workspaceBytes);
  });

  it("counts requests rather than turns, including agents with no request id", async () => {
    // The WP-214 acceptance run showed one request counted as six, because each
    // unlabelled turn was keyed by its turn id.
    await appendRecord(location, record({ turnId: "m1", requestId: "req-A" }));
    await appendRecord(location, record({ turnId: "m2", requestId: "req-A" }));
    await appendRecord(location, record({ agentId: "agent-worker-2", turnId: "w1", requestId: null }));
    await appendRecord(location, record({ agentId: "agent-worker-2", turnId: "w2", requestId: null }));
    clearTraceStoreCache();
    // One request, plus one agent that never reported a request id.
    expect(countTraces(readRecords(location, WS).records)).toBe(2);
  });

  it("reports zeroes for a store that does not exist", () => {
    expect(measureStore({ tracesDir: join(home, "nope") }, WS)).toEqual({
      bytes: 0,
      workspaceBytes: 0,
    });
  });
});

describe("append serialised with another mutation", () => {
  it("loses and duplicates no record when an append races a rewrite", async () => {
    await appendRecord(location, record());
    const path = join(location.tracesDir, WS, "events-202609.jsonl");

    // Hold the workspace lock the way a delete rewrite would, then append while
    // it is held: the append must wait, and both records must survive.
    let releaseRewrite!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseRewrite = resolveGate;
    });
    const rewrite = withWorkspaceLock(WS, async () => {
      await gate;
      const kept = readFileSync(path, "utf8");
      writeFileSync(path, kept, { mode: 0o600 });
    });

    const appended = appendRecord(location, record({ turnId: "turn-2", at: "2026-09-16T10:05:00.000Z" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(readFileSync(path, "utf8").split("\n").filter(Boolean)).toHaveLength(1);

    releaseRewrite();
    await rewrite;
    await appended;

    clearTraceStoreCache();
    const result = readRecords(location, WS);
    expect(result.records.map((r) => r.turnId)).toEqual(["turn-1", "turn-2"]);
    expect(result.skippedLines).toBe(0);
  });
});
