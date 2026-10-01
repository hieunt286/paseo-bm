import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { bmRoleSchema } from "./persisted";
import { fallbackEntryInputSchema } from "./roles";

/**
 * The fallback incidents (`fallback.*`, delta 20260921 §4.4): an agent whose
 * turn ended on a provider-plan failure, and what the owner chose to do
 * about it. The chain the owner saves (`fallbackEntryInputSchema`,
 * `fallbackSettingsSchema`, `roles.save-fallback`) belongs to Roles &
 * models, in `roles.ts`.
 * Import from `shared/contracts.ts`, which re-exports this module.
 */

/**
 * Every status of a fallback incident, in one list: `fallbackIncidentSchema`
 * stores them and the `BM-FALLBACK` notice reader (`shared/bm-fallback.ts`)
 * reads them back.
 */
export const FALLBACK_STATUSES = ["pending", "switched", "waiting", "resumed", "dismissed", "exhausted", "expired", "failed"] as const;

/**
 * One recorded fallback incident (delta 20260921 §4.4.2, §4.4.5, REQ-065 j):
 * an agent whose turn ended on a provider-plan failure, what was learnt about
 * it (class, verbatim message cut to 500 characters, reset time), the next
 * candidate of its role's chain, and what became of it. Stored in
 * `<install home>/role-fallback-state.json`.
 */
export const fallbackIncidentSchema = z.object({
  id: z.string().regex(/^fb-[0-9a-f]{12}$/),
  role: bmRoleSchema,
  workspaceId: z.string(),
  /** `null` for a Manager, which serves a workspace, not a request. */
  requestId: z.string().nullable(),
  agentId: z.string(),
  agentProvider: z.string(),
  agentModel: z.string().nullable(),
  /** The Worker of a Reviewer; the Manager of a Worker; `null` for a Manager. */
  parentId: z.string().nullable(),
  /** The chat whose card shows the incident. */
  managerId: z.string().nullable(),
  class: z.enum(["L1", "L2", "L4", "L5"]),
  /** N1 (`failed`) or N2 (`completed`). */
  signal: z.enum(["failed", "completed"]),
  message: z.string().max(500),
  perModelWindow: z.boolean(),
  resetsAt: z.string().nullable(),
  candidate: fallbackEntryInputSchema
    .extend({ position: z.number().int().min(1).max(3), alias: z.string() })
    .nullable(),
  status: z.enum(FALLBACK_STATUSES),
  detectedAt: z.string(),
  decidedAt: z.string().nullable(),
  waitUntil: z.string().nullable(),
  replacementId: z.string().nullable(),
  error: z.string().nullable(),
});

/**
 * `fallback.incidents` — the recorded incidents (§4.4.6), oldest first,
 * filtered by workspace and/or ids when given. The Inbox reads them here,
 * never from a notice's text, so an old notice never shows a button that no
 * longer applies.
 */
export const fallbackIncidentsRpc = defineRpc({
  name: "fallback.incidents",
  input: z.object({ workspaceId: z.string().min(1).optional(), ids: z.array(z.string().min(1)).max(200).optional() }),
  output: z.object({ incidents: z.array(fallbackIncidentSchema) }),
});

/**
 * `fallback.act` — the user's choice on the card for a `pending` incident:
 * switch to the candidate (§4.4.7, §4.5.1), wait for the reset (§4.4.9), or
 * handle it themselves (`dismiss`, §4.4.10). `resend` sends a switched
 * Reviewer's instructions to its Worker again when the notice queue lost them
 * (§7, "Resend to Worker"). Returns the incident as it is afterwards.
 */
export const fallbackActRpc = defineRpc({
  name: "fallback.act",
  input: z.object({ incidentId: z.string().min(1), action: z.enum(["switch", "wait", "dismiss", "resend"]) }),
  output: z.object({ incident: fallbackIncidentSchema }),
});

/**
 * Furthest ahead a `resetsAt` may lie for the card to offer "Wait until …"
 * and for `fallback.act` `wait` to accept it: 7 days (§4.4.6, §4.4.9).
 */
export const FALLBACK_MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

export type FallbackActInput = z.infer<typeof fallbackActRpc.input>;
export type FallbackIncident = z.infer<typeof fallbackIncidentSchema>;
