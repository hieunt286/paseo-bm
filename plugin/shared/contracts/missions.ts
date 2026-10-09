import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { agentIdSchema, workspaceIdSchema } from "./persisted";

/**
 * Missions and their Mains (missions design §3.3, §3.4; ADR-029):
 * `missions.create` and `mission.ensure`.
 * Import from `shared/contracts.ts`, which re-exports this module.
 */

/**
 * `missions.create` — with a `name` and a `code`, writes an open mission
 * (`createdBy: owner`) and creates its Main in the Missions home; without
 * either (the Command Center's "New mission"), creates an unassigned Main,
 * whose brief asks the owner for them (§3.3). `missionId` is null then.
 * Refused input → `E_MISSION_INVALID`; the Main cannot be created →
 * `E_PROVIDER_UNAVAILABLE`.
 */
export const missionsCreateRpc = defineRpc({
  name: "missions.create",
  input: z.object({
    name: z.string().max(80).optional(),
    code: z.string().max(8).optional(),
    repos: z.array(workspaceIdSchema).max(50).optional(),
    goal: z.string().max(4_000).optional(),
  }),
  output: z.object({
    missionId: z.string().nullable(),
    agentId: agentIdSchema,
    created: z.boolean(),
    toolsNotice: z.string().nullable().optional(),
    setupNotice: z.string().nullable().optional(),
  }),
});

export type MissionsCreateInput = z.infer<typeof missionsCreateRpc.input>;
export type MissionsCreateOutput = z.infer<typeof missionsCreateRpc.output>;

/**
 * `mission.ensure` — the live Main of an open mission (`findMain`), created in
 * the Missions home when there is none. `replace: "owner"` creates a successor
 * whatever the current Main is; `"outdated"` only when it runs older
 * instructions (§3.4). The old Main is marked `bm.replacedBy`, never archived;
 * `replacedMainId` names it. An unknown or closed mission → `E_MISSION_INVALID`.
 */
export const missionEnsureRpc = defineRpc({
  name: "mission.ensure",
  input: z.object({
    missionId: z.string().min(1),
    replace: z.enum(["outdated", "owner"]).optional(),
  }),
  output: z.object({
    agentId: agentIdSchema,
    created: z.boolean(),
    replacedMainId: agentIdSchema.nullable(),
    toolsNotice: z.string().nullable().optional(),
  }),
});

export type MissionEnsureInput = z.infer<typeof missionEnsureRpc.input>;
export type MissionEnsureOutput = z.infer<typeof missionEnsureRpc.output>;
