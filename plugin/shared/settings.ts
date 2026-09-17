import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped settings of the paseo-bm Dashboard (WP-201, REQ-055d).
 *
 * Source of truth: docs/design/paseo-bm-dashboard.md §3.6.
 *
 * Only one value for now: the size at which the Dashboard *warns* about the
 * trace store. It never deletes on its own — ADR-007 decision 6 forbids that,
 * so this threshold is a notice, not a retention policy.
 *
 * Paseo 0.8 offers exactly one settings scope, `"host"`, so this threshold is
 * one value for the whole machine rather than per workspace (REQ-055e). The
 * screen has to say that out loud; Q-042 records the option of a per-workspace
 * threshold and deliberately leaves it unbuilt.
 *
 * This module is `shared/`, so it stays free of Node and React Native imports.
 */

/** 200 MB — the agreed default warning threshold (Q-040). */
export const DEFAULT_WARN_ABOVE_BYTES = 200 * 1024 * 1024;

/**
 * Stored shape. `warnAboveBytes` must be a positive integer: zero would warn
 * forever and a negative number is meaningless, so both are rejected at the
 * write and the previously stored value stays in effect (REQ-055f).
 */
export const dashboardSettingsSchema = z.object({
  warnAboveBytes: z.number().int().positive().default(DEFAULT_WARN_ABOVE_BYTES),
});

/**
 * Keeps a stored threshold across a future schema version bump.
 *
 * Version 1 has nothing to migrate *from*, but the hook has to exist now:
 * without it, bumping `version` later would silently drop the user's threshold
 * back to the default. It ignores `fromVersion` on purpose: there is only one
 * version so far, and the value it carries is validated the same way whatever
 * version wrote it. A stored value that no longer validates is dropped on
 * purpose — falling back to a known-good default beats carrying a broken one.
 */
export function migrateDashboardSettings(values: unknown): unknown {
  const stored = (values as { warnAboveBytes?: unknown } | null | undefined)?.warnAboveBytes;
  return dashboardSettingsSchema.safeParse({ warnAboveBytes: stored }).success
    ? { warnAboveBytes: stored }
    : {};
}

/** The definition `index.server.ts` registers and the settings screen reads with `useSettings`. */
export const dashboardSettings = defineSettings({
  id: "paseo-bm",
  scope: "host",
  version: 1,
  schema: dashboardSettingsSchema,
  migrate: migrateDashboardSettings,
});
