import { z } from "zod";

/**
 * Inbox alerts (autonomy design §A.8): what needs the owner's eyes without
 * being a decision — a request that stopped moving, a Worker waiting on a
 * permission, a risky command, a Worker that looks stuck, a role created by the
 * wrong role, an agent on older instructions, a fallback action that failed,
 * compaction or handoff switched off below A-12's target (§G.3, §G.7), two agents writing one file
 * in overlapping turns (§F.1), a Worker or Reviewer running without the
 * action boundary in a project where it is on (§D.2, change-010 C6), a
 * report, review or message the plugin could not deliver (design §16.7).
 *
 * Kept in `<data folder>/inbox/alerts.json` (`server/alert-store.ts`), shared
 * here so the Inbox (part b) reads the same shape. An alert is data the Inbox
 * shows; it is never a message to anybody. An entry of a kind this build no
 * longer has (`autonomy-demoted`, removed by ADR-025) is skipped when the
 * store is read and dropped by its next write.
 *
 * This module is `shared/`, so it stays free of Node and React Native imports.
 */

/** Every alert kind, in the order the Inbox lists them. */
export const ALERT_KINDS = [
  "request-stalled",
  "permission-waiting",
  "danger",
  "stuck",
  "writers-observed",
  "pairing-mismatch",
  "outdated-agent",
  "fallback-failed",
  "delivery-dropped",
  "coordination-off",
  "boundary-off",
] as const;
export const alertKindSchema = z.enum(ALERT_KINDS);
export type AlertKind = z.infer<typeof alertKindSchema>;

/** The roles an `outdated-agent` alert can name; the Inbox offers a Manager's replacement. */
export const alertRoleSchema = z.enum(["manager", "worker", "reviewer"]);
export type AlertRole = z.infer<typeof alertRoleSchema>;

/** Longest `detail` an alert keeps. */
export const MAX_ALERT_DETAIL_CHARS = 300;

/**
 * One alert. Open while `clearedAt` is null. `subject` names what it is about:
 * the request key (`request-stalled`), the Worker's id (`permission-waiting`,
 * `danger`, `stuck`), the agent's id (`pairing-mismatch`, `outdated-agent`,
 * `boundary-off`),
 * the decision's id (`fallback-failed`), the request's id (`delivery-dropped`,
 * the record in its detail) or the mechanism
 * (`coordination-off`: `compact` or `handoff`, for every project) or the file,
 * relative to the workspace folder (`writers-observed`).
 * `workspaceId` is null when the project is not known (an agent created
 * outside a workspace) or the alert is about every project
 * (`coordination-off`). `detail` is an
 * optional short line, already redacted: why the request stalled, what the
 * permission asks, which risky command ran. `role` is set on an
 * `outdated-agent` alert: the Inbox offers to replace a Manager and only to
 * open a Worker or a Reviewer.
 */
export const alertEntrySchema = z.object({
  workspaceId: z.string().min(1).nullable(),
  kind: alertKindSchema,
  subject: z.string().min(1),
  since: z.string(),
  clearedAt: z.string().nullable(),
  detail: z.string().max(MAX_ALERT_DETAIL_CHARS).optional(),
  role: alertRoleSchema.optional(),
});
export type AlertEntry = z.infer<typeof alertEntrySchema>;

/** An alert with its key. */
export type Alert = AlertEntry & { key: string };

/** An alert with its key, as `inbox.alerts` returns it. */
export const alertSchema = alertEntrySchema.extend({ key: z.string().min(1) });

/** The file format this build reads and writes. */
export const ALERTS_FILE_VERSION = 1;

/**
 * The key of an alert: `<kind>:<workspaceId or ->:<subject>`. One key is raised
 * once while open; a cleared key raised again opens afresh.
 */
export function alertKeyOf(kind: AlertKind, workspaceId: string | null, subject: string): string {
  return `${kind}:${workspaceId ?? "-"}:${subject}`;
}
