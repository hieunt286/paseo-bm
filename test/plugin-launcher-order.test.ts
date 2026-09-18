import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAUNCHER_ORDER_SCHEMA_VERSION,
  launcherOrderPath,
  readLauncherOrder,
  writeLauncherOrder,
} from "../plugin/server/launcher-order";
import { DashboardError } from "../plugin/shared/contracts";
import type { TraceStoreLocation } from "../plugin/server/trace-store";

/**
 * The order the owner pinned on the Beads Manager screen (delta 20260917e §4.1).
 *
 * The rule that shapes every case below: a preference file that cannot be read
 * must never take the screen down, and must never be silently rewritten. Losing
 * an ordering is an annoyance; overwriting whatever a newer version wrote is
 * data loss.
 */
describe("launcher pin order", () => {
  let home: string;
  let location: TraceStoreLocation;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bm-launcher-order-"));
    location = { tracesDir: join(home, "traces") } as TraceStoreLocation;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const writeRaw = (body: string) => {
    mkdirSync(join(home, "ui"), { recursive: true });
    writeFileSync(launcherOrderPath(location), body);
  };

  it("reads back what it wrote", () => {
    writeLauncherOrder(location, ["wks_a", "wks_b"]);
    expect(readLauncherOrder(location).pinned).toEqual(["wks_a", "wks_b"]);
  });

  it("treats a missing file as nothing pinned, not as an error", () => {
    const order = readLauncherOrder(location);
    expect(order.pinned).toEqual([]);
    expect(order.notices).toEqual([]);
  });

  it("survives a file that is not JSON, and leaves it alone", () => {
    writeRaw("{ this is not json");
    const order = readLauncherOrder(location);
    expect(order.pinned).toEqual([]);
    expect(order.notices.join(" ")).toMatch(/not valid JSON/i);
    // The read did not repair the file.
    expect(readLauncherOrder(location).notices).toHaveLength(1);
  });

  it("survives a file of the wrong shape", () => {
    writeRaw(JSON.stringify({ schemaVersion: 1, pinned: "wks_a" }));
    expect(readLauncherOrder(location).notices.join(" ")).toMatch(/expected shape/i);
  });

  it("refuses to overwrite a file written by a newer version", () => {
    writeRaw(JSON.stringify({ schemaVersion: LAUNCHER_ORDER_SCHEMA_VERSION + 1, pinned: ["wks_future"] }));
    const order = readLauncherOrder(location);
    expect(order.pinned).toEqual([]);
    expect(order.tooNew).toBe(true);
    expect(() => writeLauncherOrder(location, ["wks_a"])).toThrow(DashboardError);
    // And the newer file is still there, untouched.
    expect(readLauncherOrder(location).tooNew).toBe(true);
  });

  it("drops an id that could not name a directory, and says how many", () => {
    writeRaw(JSON.stringify({ schemaVersion: 1, pinned: ["wks_a", "../escape", "wks_b"] }));
    const order = readLauncherOrder(location);
    expect(order.pinned).toEqual(["wks_a", "wks_b"]);
    expect(order.notices.join(" ")).toMatch(/1 unusable/i);
  });

  it("refuses to write an id that could not name a directory", () => {
    expect(() => writeLauncherOrder(location, ["wks_a", "../escape"])).toThrow(DashboardError);
  });

  it("keeps the first position of a duplicated id", () => {
    expect(writeLauncherOrder(location, ["wks_a", "wks_b", "wks_a"]).pinned).toEqual(["wks_a", "wks_b"]);
  });

  it("refuses a symlink anywhere on the path", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "bm-elsewhere-"));
    try {
      symlinkSync(elsewhere, join(home, "ui"));
      expect(() => readLauncherOrder(location)).toThrow(DashboardError);
      expect(() => writeLauncherOrder(location, ["wks_a"])).toThrow(DashboardError);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
