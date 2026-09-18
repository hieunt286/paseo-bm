import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANSWER_MARKS_LIMIT,
  ANSWER_MARKS_SCHEMA_VERSION,
  answerMarksPath,
  readAnswerMarks,
  writeAnswerMark,
} from "../plugin/server/answer-marks";
import { handleAnswerMarkSet, handleAnswerMarksGet, type DashboardPaseo } from "../plugin/server/dashboard-rpc";
import { DashboardError } from "../plugin/shared/contracts";
import type { TraceStoreLocation } from "../plugin/server/trace-store";

/**
 * "Mark as answered" marks (delta 20260918d-card-replies §4.9, owner decision
 * Q16 a): kept in the install home like the launcher's pinned order, never
 * repaired on read, never written over a newer version's file.
 */
describe("answer marks", () => {
  let home: string;
  let location: TraceStoreLocation;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bm-answer-marks-"));
    location = { tracesDir: join(home, "traces") } as TraceStoreLocation;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const writeRaw = (body: string) => {
    mkdirSync(join(home, "ui"), { recursive: true });
    writeFileSync(answerMarksPath(location), body);
  };

  it("reads back what it wrote, removes a mark, and never duplicates one", () => {
    writeAnswerMark(location, "m1|req-a|Q1|x", true);
    writeAnswerMark(location, "m1|req-b|Q2|y", true);
    expect(readAnswerMarks(location).keys).toEqual(["m1|req-a|Q1|x", "m1|req-b|Q2|y"]);
    writeAnswerMark(location, "m1|req-a|Q1|x", true);
    expect(readAnswerMarks(location).keys).toEqual(["m1|req-b|Q2|y", "m1|req-a|Q1|x"]);
    expect(writeAnswerMark(location, "m1|req-b|Q2|y", false).keys).toEqual(["m1|req-a|Q1|x"]);
    const file = JSON.parse(readFileSync(answerMarksPath(location), "utf8"));
    expect(file.schemaVersion).toBe(ANSWER_MARKS_SCHEMA_VERSION);
    expect(file.marks[0]).toMatchObject({ key: "m1|req-a|Q1|x" });
  });

  it("keeps only the newest marks", () => {
    const full = Array.from({ length: ANSWER_MARKS_LIMIT + 2 }, (_, n) => ({ key: `k${n}`, at: "2026-09-18T00:00:00.000Z" }));
    writeRaw(JSON.stringify({ schemaVersion: 1, marks: full }));
    writeAnswerMark(location, "newest", true);
    const { keys } = readAnswerMarks(location);
    expect(keys).toHaveLength(ANSWER_MARKS_LIMIT);
    expect(keys[0]).toBe("k3");
    expect(keys.at(-1)).toBe("newest");
  });

  it("reads nothing from a missing file, quietly", () => {
    expect(readAnswerMarks(location)).toEqual({ keys: [], notices: [], tooNew: false });
  });

  it("reads a broken file as no marks, says so, and leaves it alone", () => {
    writeRaw("{not json");
    expect(readAnswerMarks(location)).toMatchObject({ keys: [], tooNew: false, notices: [expect.stringContaining("not valid JSON")] });
    expect(readFileSync(answerMarksPath(location), "utf8")).toBe("{not json");
    writeRaw(JSON.stringify({ schemaVersion: 1, marks: "nope" }));
    expect(readAnswerMarks(location).notices).toEqual([expect.stringContaining("expected shape")]);
  });

  it("refuses to overwrite a newer file", () => {
    writeRaw(JSON.stringify({ schemaVersion: ANSWER_MARKS_SCHEMA_VERSION + 1, marks: [] }));
    expect(readAnswerMarks(location)).toMatchObject({ keys: [], tooNew: true });
    expect(() => writeAnswerMark(location, "m1|req-a|Q1|x", true)).toThrow(DashboardError);
  });

  it("refuses unusable keys, and drops them on read", () => {
    const bell = `bad${String.fromCharCode(7)}key`;
    for (const key of ["", "x".repeat(401), bell]) {
      expect(() => writeAnswerMark(location, key, true), JSON.stringify(key)).toThrow(DashboardError);
    }
    writeRaw(JSON.stringify({ schemaVersion: 1, marks: [{ key: "good", at: "t" }, { key: bell, at: "t" }] }));
    expect(readAnswerMarks(location)).toMatchObject({ keys: ["good"], notices: [expect.stringContaining("Ignored 1")] });
  });

  it("refuses a symlinked ui directory", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "bm-answer-marks-elsewhere-"));
    try {
      symlinkSync(elsewhere, join(home, "ui"));
      expect(() => readAnswerMarks(location)).toThrow();
      expect(() => writeAnswerMark(location, "m1|req-a|Q1|x", true)).toThrow();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("answers.marks and answers.mark", () => {
  let user: string;
  beforeEach(() => {
    user = mkdtempSync(join(tmpdir(), "bm-answer-marks-home-"));
    mkdirSync(join(user, ".paseo-bm"), { recursive: true });
    writeFileSync(join(user, ".paseo-bm", "install.json"), JSON.stringify({ schemaVersion: 1 }));
  });
  afterEach(() => rmSync(user, { recursive: true, force: true }));

  const paseo = (): DashboardPaseo => ({
    agents: { list: vi.fn(async () => ({ entries: [] })) },
    workspaces: { list: vi.fn(async () => ({ entries: [] })) },
    config: { get: vi.fn(async () => ({ config: {} })) },
  });

  it("write through the install home and read the marks back", async () => {
    const deps = { homedir: () => user };
    expect(await handleAnswerMarksGet(paseo(), deps)).toEqual({ keys: [], notices: [] });
    expect(await handleAnswerMarkSet({ key: "m1|req-a|Q1|x", marked: true }, paseo(), deps)).toEqual({ keys: ["m1|req-a|Q1|x"], notices: [] });
    expect(await handleAnswerMarksGet(paseo(), deps)).toEqual({ keys: ["m1|req-a|Q1|x"], notices: [] });
    expect(readFileSync(join(user, ".paseo-bm", "ui", "answer-marks.json"), "utf8")).toContain("m1|req-a|Q1|x");
  });
});
