import { describe, expect, it } from "vitest";
import {
  DEFAULT_WARN_ABOVE_BYTES,
  dashboardSettings,
  dashboardSettingsSchema,
  migrateDashboardSettings,
} from "../plugin/shared/settings";

/**
 * WP-201: the host-scoped Dashboard settings definition (REQ-055d, REQ-055e,
 * REQ-055f). The point of these tests is that a bad value can never replace a
 * good threshold, and that a future version bump cannot silently reset it.
 */

describe("dashboard settings definition", () => {
  it("is host-scoped version 1 under the plugin id", () => {
    expect(dashboardSettings.id).toBe("paseo-bm");
    expect(dashboardSettings.scope).toBe("host");
    expect(dashboardSettings.version).toBe(1);
  });

  it("defaults to 200 MB when nothing is stored", () => {
    expect(DEFAULT_WARN_ABOVE_BYTES).toBe(209_715_200);
    expect(dashboardSettingsSchema.parse({}).warnAboveBytes).toBe(DEFAULT_WARN_ABOVE_BYTES);
  });

  it("accepts a positive integer threshold", () => {
    expect(dashboardSettingsSchema.parse({ warnAboveBytes: 50_000_000 }).warnAboveBytes).toBe(50_000_000);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1024.5],
    ["a string", "200MB"],
    ["null", null],
  ])("rejects %s instead of storing it", (_label, value) => {
    expect(dashboardSettingsSchema.safeParse({ warnAboveBytes: value }).success).toBe(false);
  });
});

describe("settings migration", () => {
  it("preserves an existing valid threshold", () => {
    expect(migrateDashboardSettings({ warnAboveBytes: 12_345_678 })).toEqual({
      warnAboveBytes: 12_345_678,
    });
  });

  it("falls back to the default when the stored value is unusable", () => {
    for (const broken of [{ warnAboveBytes: 0 }, { warnAboveBytes: "big" }, {}, null, undefined]) {
      const migrated = migrateDashboardSettings(broken);
      expect(dashboardSettingsSchema.parse(migrated).warnAboveBytes).toBe(DEFAULT_WARN_ABOVE_BYTES);
    }
  });

  it("is wired into the definition so a version bump cannot drop the value", () => {
    expect(typeof dashboardSettings.migrate).toBe("function");
    expect(dashboardSettings.migrate?.({ warnAboveBytes: 777 }, 1)).toEqual({ warnAboveBytes: 777 });
  });
});
