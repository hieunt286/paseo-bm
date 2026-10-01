import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { modelPriceSchema } from "../prices";
import { agentIdSchema, agentRoleSchema, bmRoleSchema, setupRoleWithOrchestratorSchema, workspaceIdSchema } from "./persisted";

/**
 * The roles and their agents: `manager.ensure`, the agent tree
 * (`agents.list`) and `roles.describe` (Phase 1), and Roles & models
 * (`roles.*`), where the owner sets each role's provider, model, thinking,
 * mode and fallback chain. The incidents that chain answers are in
 * `fallback.ts`.
 * Import from `shared/contracts.ts`, which re-exports this module.
 */

// ---------------------------------------------------------------------------
// The role agents (Phase 1, WP-108; Technical Design §7.3).
// ---------------------------------------------------------------------------

/**
 * `manager.ensure` — find the live Manager of a workspace by its `bm.role=manager`
 * label, or create one from the `bm-manager` profile with the instructions in
 * `roles/manager.md`. `created` reports which of the two happened.
 *
 * `otherManagerIds` lists the other live Managers of the same workspace (newest
 * first) when more than one exists; `agentId` is then the newest. They are
 * reported, never deleted or archived (Technical Design §7.3). It is the only
 * channel for the "report it in the panel" requirement (see the WP-112 report).
 *
 * `replaceOutdated` (autonomy PRD §11 rule 3, the Inbox's `outdated-agent`
 * alert): when the live Manager runs older instructions (`bm.instructions`),
 * create a new one and mark the old one `bm.replacedBy`, never archiving it;
 * `replacedManagerId` names it. A current Manager is returned as it is.
 *
 * Failures are thrown as errors whose message starts with a registry code
 * (`E_PROVIDER_UNAVAILABLE`).
 */
export const managerEnsureRpc = defineRpc({
  name: "manager.ensure",
  input: z.object({
    workspaceId: workspaceIdSchema,
    replaceOutdated: z.boolean().optional(),
  }),
  output: z.object({
    agentId: agentIdSchema,
    created: z.boolean(),
    otherManagerIds: z.array(agentIdSchema),
    /**
     * Why an existing Manager was not switched to its no-prompt mode, or `null`
     * (delta 20260918 §4.1). Added field: a client that does not know it drops it.
     */
    modeNotice: z.string().nullable(),
    /**
     * Set when the Manager just created has no Paseo tools (delta 20260921
     * §4.2.4). Optional so an older server's answer still parses; the server
     * always sends it.
     */
    toolsNotice: z.string().nullable().optional(),
    /**
     * What the user should know about this machine's setup: roles this call
     * created with defaults, and Paseo's agent-tools switch being off (design
     * §7.3, ADR-012 decision 4). Optional so an older server's answer still
     * parses; the server always sends it.
     */
    setupNotice: z.string().nullable().optional(),
    /**
     * The outdated Manager this call replaced, or `null`. Optional so an older
     * server's answer still parses; the server always sends it.
     */
    replacedManagerId: agentIdSchema.nullable().optional(),
  }),
});

/**
 * One node of the agent tree the workspace panel draws.
 *
 * `role` is `unknown` when the agent carries no readable `bm.role` label; the
 * panel renders that instead of dropping the agent (Technical Design §7.3).
 * `title` mirrors the SDK snapshot, which may be `null` (untitled agent).
 * `parentId` is the `paseo.parent-agent-id` label when that parent is itself in
 * the list, otherwise `null` — so an orphaned Worker (its Manager deleted or
 * archived) is a root of the tree (Technical Design §7.3).
 */
export const agentNodeSchema = z.object({
  id: agentIdSchema,
  role: agentRoleSchema,
  title: z.string().nullable(),
  status: z.string(),
  parentId: agentIdSchema.nullable(),
  updatedAt: z.string(),
  /**
   * False when the agent has no valid `bm.role` label: its role came from its
   * provider, or it is an unlabelled descendant (delta 20260918g §4.4).
   * Defaults to true for older servers.
   */
  labelled: z.boolean().default(true),
  /**
   * The agent that replaced this one after a fallback switch: its `bm.replacedBy`
   * label, else the replacement of a `switched` incident (delta 20260921
   * §4.4.8). Defaults to null for older servers.
   */
  replacedBy: z.string().nullable().default(null),
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
 * Read from the Paseo configuration in effect (errata bm-dnc): `provider` is the
 * base provider the role's derived provider extends, `model` comes from the
 * role's agent profile, `paseoTools` is whether the derived provider currently
 * has the Paseo agent tools enabled, and `instructionsPath` is the name of the
 * role's instructions inside the payload (e.g. `roles/manager.md`), not an
 * on-disk path.
 */
export const roleDescriptorSchema = z.object({
  role: setupRoleWithOrchestratorSchema,
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

/** Input shape: `labelled` may be absent (meaning labelled), as from a server older than delta 20260918g. */
export type AgentNode = z.input<typeof agentNodeSchema>;
export type RoleDescriptor = z.infer<typeof roleDescriptorSchema>;

// ---------------------------------------------------------------------------
// Roles & models (delta 20260921 §4.3.2, REQ-064 a/b). Read-only; saving is
// `roles.save-settings` (§4.3.4). `roles.describe` stays for older clients.
// ---------------------------------------------------------------------------

/**
 * How a provider lets paseo-bm choose a role's start mode (delta 20260921
 * §4.2.1): `tiered` (modes carry a `colorTier`: Claude, Codex), `untiered`
 * (modes without one: OpenCode), `none` (no modes, no error: Pi), `unknown`
 * (the modes could not be read).
 */
export const providerCapabilitySchema = z.enum(["tiered", "untiered", "none", "unknown"]);

/**
 * One role as Paseo's configuration has it right now: `baseProvider` and
 * `label` from the derived provider `bm-<role>` (`extends`, `label`); `model`,
 * `thinkingOptionId`, `modeId` and `featureValues` from the agent profile
 * `bm-<role>`. A field the configuration does not set is `null`
 * (`featureValues`: `{}`); `capability` is that of `baseProvider`.
 */
export const roleSettingSchema = z.object({
  role: setupRoleWithOrchestratorSchema,
  providerId: z.enum(["bm-manager", "bm-worker", "bm-reviewer", "bm-orchestrator"]),
  baseProvider: z.string().nullable(),
  label: z.string().nullable(),
  model: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  modeId: z.string().nullable(),
  featureValues: z.record(z.string(), z.unknown()),
  capability: providerCapabilitySchema,
});

/**
 * One entry of a role's fallback chain as the user saves it (delta 20260921
 * §4.4.2–§4.4.3): a BASE provider (never a `bm-*` alias), one of its models,
 * and optional thinking and mode (`null` = not set).
 */
export const fallbackEntryInputSchema = z.object({
  baseProvider: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  thinkingOptionId: z.string().min(1).max(200).nullable(),
  modeId: z.string().min(1).max(200).nullable(),
});

/**
 * A role's fallback chain as Roles & models shows it: the policy (`ask`
 * opens the owner's decision when the role hits a plan limit, `off` does
 * nothing), the entries in order with the alias each runs on
 * (`bm-<role>-fallback-<position>`), the capability and listed price of each
 * entry's provider and model, and whether detection patterns come from the
 * user's `role-fallback.json`. `migratedFromAuto` is `true` while that file
 * still stores the retired Auto switch for the role (read as `ask`, ADR-022
 * decision 4); absent otherwise.
 */
export const fallbackSettingsSchema = z.object({
  role: bmRoleSchema,
  policy: z.enum(["ask", "off"]),
  migratedFromAuto: z.boolean().optional(),
  entries: z.array(
    fallbackEntryInputSchema.extend({
      position: z.number().int().min(1).max(3),
      alias: z.string(),
      capability: providerCapabilitySchema,
      cost: modelPriceSchema.nullable(),
    }),
  ),
  patternsFromFile: z.boolean(),
});

/**
 * `roles.settings` — the four roles, always in the order manager, worker,
 * reviewer, orchestrator. `revision` is what `roles.save-settings` must send back: sha256 of
 * the canonical JSON of every `bm-*` provider and the whole profile array
 * (§4.3.2). `fallback` holds the chain of each role whose chain is offered
 * (`FALLBACK_ROLES`, §4.4.3); `null` when none is.
 * `warnings` are English sentences for the user, e.g. the shared-plan warning
 * when the Manager and the Worker extend the same base provider.
 */
export const rolesSettingsRpc = defineRpc({
  name: "roles.settings",
  input: z.object({}),
  output: z.object({
    revision: z.string(),
    roles: z.array(roleSettingSchema),
    fallback: z
      .object({
        manager: fallbackSettingsSchema.optional(),
        worker: fallbackSettingsSchema.optional(),
        reviewer: fallbackSettingsSchema.optional(),
      })
      .nullable(),
    warnings: z.array(z.string()),
    /** The base providers Paseo reports as available (never a `bm-*` alias), for the Edit form's Provider picker. */
    providers: z.array(z.string()),
  }),
});

/** A model a role can run, as `providers.listModels` lists it; `cost` from its `metadata.cost` (§4.2.7). */
export const roleModelOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  thinkingOptions: z.array(z.object({ id: z.string(), label: z.string() })),
  defaultThinkingOptionId: z.string().nullable(),
  cost: modelPriceSchema.nullable(),
});

/** A mode as `providers.listModes` lists it; `colorTier` is `null` when the provider gives none. */
export const roleModeOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  colorTier: z.string().nullable(),
});

/**
 * `roles.options` — what the Edit form of Roles & models may offer for one
 * BASE provider (never a `bm-*` alias: refused with `E_ROLE_SETTINGS_INVALID`).
 * Only values Paseo lists; a list Paseo cannot give is empty. `autoAccept` is
 * true when an `untiered` provider offers the `auto_accept` toggle.
 */
export const rolesOptionsRpc = defineRpc({
  name: "roles.options",
  input: z.object({ provider: z.string().min(1) }),
  output: z.object({
    provider: z.string(),
    capability: providerCapabilitySchema,
    models: z.array(roleModelOptionSchema),
    modes: z.array(roleModeOptionSchema),
    autoAccept: z.boolean(),
  }),
});

/**
 * `roles.save-settings` — writes one role's base provider, model, thinking and
 * mode into Paseo's config (delta 20260921 §4.3.2–§4.3.4, ADR-008). `null`
 * thinking / mode means "not set" (the key is removed). `notified` counts the
 * live agents told a changed child mode (BM-SETTINGS, §4.3.5).
 */
export const rolesSaveSettingsRpc = defineRpc({
  name: "roles.save-settings",
  input: z.object({
    revision: z.string().min(1),
    role: setupRoleWithOrchestratorSchema,
    baseProvider: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    thinkingOptionId: z.string().min(1).max(200).nullable(),
    modeId: z.string().min(1).max(200).nullable(),
  }),
  output: z.object({
    revision: z.string(),
    role: roleSettingSchema,
    warnings: z.array(z.string()),
    notified: z.number().int(),
  }),
});

/**
 * `roles.save-fallback` — saves one role's policy and 0–3 fallback entries
 * (delta 20260921 §4.4.3, §4.6): the aliases through the config writer (so
 * `revision` guards them like `roles.save-settings`), then `role-fallback.json`.
 */
export const rolesSaveFallbackRpc = defineRpc({
  name: "roles.save-fallback",
  input: z.object({
    revision: z.string().min(1),
    role: bmRoleSchema,
    /** The Auto switch (`auto`) was retired (ADR-022 decision 4); the handler refuses it with `E_ROLE_SETTINGS_INVALID`. */
    policy: z.enum(["ask", "off"]),
    entries: z.array(fallbackEntryInputSchema).max(3),
  }),
  output: z.object({
    revision: z.string(),
    fallback: fallbackSettingsSchema,
    warnings: z.array(z.string()),
  }),
});

export type FallbackEntryInput = z.infer<typeof fallbackEntryInputSchema>;
export type FallbackSettings = z.infer<typeof fallbackSettingsSchema>;
export type RolesSaveFallbackInput = z.infer<typeof rolesSaveFallbackRpc.input>;
export type RolesSaveSettingsInput = z.infer<typeof rolesSaveSettingsRpc.input>;
export type RoleSetting = z.infer<typeof roleSettingSchema>;
export type RolesSettings = z.infer<typeof rolesSettingsRpc.output>;
export type RoleModelOption = z.infer<typeof roleModelOptionSchema>;
export type RoleModeOption = z.infer<typeof roleModeOptionSchema>;
export type RolesOptions = z.infer<typeof rolesOptionsRpc.output>;
