import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * RPC contracts for the paseo-bm plugin.
 *
 * Source of truth: docs/design/paseo-bm.md §5 ("Hợp đồng RPC của plugin").
 * This module is `shared/`, so it must stay free of Node and React Native
 * runtime imports: Zod schemas and plain values only.
 *
 * WP-108 delivers the contracts. Handler behaviour lives in `server/` (WP-112)
 * and the surfaces that call them live in `client/` (WP-113).
 */

/** Value of the `bm.role` agent label that paseo-bm sets when it creates an agent. */
export const bmRoleSchema = z.enum(["manager", "worker", "reviewer"]);

/** Identifier of a Paseo workspace, as returned by the Paseo SDK. */
export const workspaceIdSchema = z.string().min(1);

/** Identifier of a Paseo agent, as returned by the Paseo SDK. */
export const agentIdSchema = z.string().min(1);

/**
 * `manager.ensure` — find the live Manager of a workspace by its `bm.role=manager`
 * label, or create one from the `bm-manager` profile with the instructions in
 * `roles/manager.md`. `created` reports which of the two happened.
 */
export const managerEnsureRpc = defineRpc({
  name: "manager.ensure",
  input: z.object({
    workspaceId: workspaceIdSchema,
  }),
  output: z.object({
    agentId: agentIdSchema,
    created: z.boolean(),
  }),
});

/**
 * One node of the agent tree the workspace panel draws.
 *
 * `role` is `null` when the agent carries no readable `bm.role` label; the panel
 * renders that as "unknown role" instead of dropping the agent (design §5).
 * `parentId` is `null` for an agent with no `paseo.parent-agent-id` label, which
 * is how an orphaned Worker reaches the "no Manager" branch (design §8).
 */
export const agentNodeSchema = z.object({
  id: agentIdSchema,
  role: bmRoleSchema.nullable(),
  title: z.string(),
  status: z.string(),
  parentId: agentIdSchema.nullable(),
  updatedAt: z.string(),
});

/**
 * `agents.list` — the agents of one workspace, flat. The caller builds the tree
 * from `role` and `parentId`.
 */
export const agentsListRpc = defineRpc({
  name: "agents.list",
  input: z.object({
    workspaceId: workspaceIdSchema,
  }),
  output: z.object({
    agents: z.array(agentNodeSchema),
  }),
});

/**
 * One row of the effective role configuration the panel shows (REQ-032d).
 *
 * `paseoTools` is whether the role's profile currently has the Paseo agent tools
 * granted; `instructionsPath` is the on-disk path of the role's `roles/*.md`
 * inside the install home.
 */
export const roleDescriptorSchema = z.object({
  role: bmRoleSchema,
  provider: z.string(),
  model: z.string(),
  paseoTools: z.boolean(),
  instructionsPath: z.string(),
});

/**
 * `roles.describe` — the role configuration in effect right now. Takes no input.
 */
export const rolesDescribeRpc = defineRpc({
  name: "roles.describe",
  input: z.object({}),
  output: z.object({
    roles: z.array(roleDescriptorSchema),
  }),
});

export type BmRole = z.infer<typeof bmRoleSchema>;
export type AgentNode = z.infer<typeof agentNodeSchema>;
export type RoleDescriptor = z.infer<typeof roleDescriptorSchema>;
