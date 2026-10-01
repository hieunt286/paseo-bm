import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { setupRoleWithOrchestratorSchema } from "./persisted";

/**
 * Machine set-up, behind Settings (Technical Design §7.13): the tools and
 * skills at a glance, creating the roles, Paseo's agent-tools switch,
 * installing skills or a tool, and removing paseo-bm's settings.
 * Import from `shared/contracts.ts`, which re-exports this module.
 */

// ---------------------------------------------------------------------------
// Machine set-up, behind Settings (delta 20260916-setup-screen).
// ---------------------------------------------------------------------------

/** The roles Setup lists, creates and keeps additional instructions for: all four. */
export const setupRoleSchema = setupRoleWithOrchestratorSchema;
const skillStateSchema = z.enum(["ok", "missing", "broken"]);
/** The Reviewer's own provider and model when `ensureRoles` put it apart from the default. */
const reviewerApartSchema = z.object({ baseProvider: z.string(), model: z.string() });

/** One Paseo-tools check (`plugin/server/tools-check.ts`). */
export const toolsSeenSchema = z.object({
  state: z.enum(["ok", "missing", "unknown"]),
  agentId: z.string(),
  provider: z.string(),
  at: z.string(),
});

/** How many required skills each agent is missing (shared by `setup.status` and `setup.install-skills`). */
const missingRequiredSchema = z.object({
  claude: z.number().int(),
  codex: z.number().int(),
  pi: z.number().int().optional(),
  opencode: z.number().int().optional(),
});

export const setupStatusSchema = z.object({
  tools: z.array(
    z.object({
      id: z.enum(["br", "bv", "bd"]),
      name: z.string(),
      purpose: z.string(),
      required: z.boolean(),
      path: z.string().nullable(),
      version: z.string().nullable(),
      latestKnown: z.string().nullable(),
      installCommand: z.string().nullable(),
      updateCommand: z.string().nullable(),
      homepage: z.string(),
    }),
  ),
  latestCheckedOn: z.string(),
  /**
   * `pi` and `opencode` (delta 20260921 §4.2.6) are optional so a payload
   * from before them still parses; a client shows those columns only when
   * they are present.
   */
  skills: z.object({
    checkedAt: z.string(),
    dirs: z.object({
      shared: z.string(),
      claude: z.string(),
      codex: z.string(),
      pi: z.string().optional(),
      opencode: z.string().optional(),
    }),
    skills: z.array(
      z.object({
        name: z.string(),
        required: z.boolean(),
        claude: skillStateSchema,
        codex: skillStateSchema,
        pi: skillStateSchema.optional(),
        opencode: skillStateSchema.optional(),
        problem: z.string().nullable(),
      }),
    ),
    missingRequired: missingRequiredSchema,
    installCommand: z.string(),
  }),
  /**
   * Everything else about this machine's setup (0.4.0, design §7.13.5).
   *
   * Optional so an older server's answer still parses; the server always sends
   * it. Read-only: building it writes nothing and runs no third-party tool.
   */
  setup: z
    .object({
      roles: z.object({
        present: z.array(setupRoleSchema),
        missing: z.array(setupRoleSchema),
        created: z
          .object({
            at: z.string(),
            roles: z.array(setupRoleSchema),
            baseProvider: z.string(),
            model: z.string(),
            /** Only when the Reviewer went to another model family (autonomy design §C.5); an older server omits it. */
            reviewer: reviewerApartSchema.optional(),
          })
          .nullable(),
        cleanedUpAt: z.string().nullable(),
      }),
      agentTools: z.object({
        /** `null` when the configuration could not be read at all. */
        injectIntoAgents: z.boolean().nullable(),
        setBy: z.enum(["plugin", "installer"]).nullable(),
      }),
      /**
       * One entry per distinct provider the four roles run on. Only the
       * sign-in boolean is ever taken from Paseo's diagnostic; paseo-bm never
       * runs a login command and never sees a credential (design §9).
       */
      logins: z.array(
        z.object({
          provider: z.string(),
          roles: z.array(setupRoleSchema),
          state: z.enum(["logged-in", "logged-out", "unknown"]),
          loginCommand: z.string().nullable(),
          guidance: z.string().nullable(),
        }),
      ),
      skillsRun: z
        .object({ at: z.string(), command: z.string(), code: z.number().int(), outcome: z.enum(["ok", "failed", "timeout"]) })
        .nullable(),
      dataHome: z.object({
        path: z.string().nullable(),
        source: z.enum(["env", "pointer", "default"]).nullable(),
        reason: z.string().nullable(),
      }),
    })
    .optional(),
  /**
   * The last Paseo-tools check of a new Manager and of a new Worker in this
   * plugin run, `null` when none ran (delta 20260921 §4.2.4). Optional: an
   * older server does not send it.
   */
  paseoTools: z
    .object({ manager: toolsSeenSchema.nullable(), worker: toolsSeenSchema.nullable() })
    .optional(),
});

export type SetupStatus = z.infer<typeof setupStatusSchema>;

/** `setup.status` — tools and skills at a glance. Read-only; runs `--version` only. */
export const setupStatusRpc = defineRpc({ name: "setup.status", input: z.object({}), output: setupStatusSchema });

/**
 * `setup.ensure-roles` — creates whichever of the four roles is missing
 * (design §7.13.2, ADR-012 decision 4; `orchestrator` from orchestrator design §3.1).
 *
 * No `confirmed` field, unlike the other setup verbs: creating the roles grants
 * nothing the user does not already have — the entries only describe agents
 * paseo-bm itself starts — so the screen calls it on open. `resume` is the one
 * way past the mark left by "Remove paseo-bm's settings".
 */
export const setupEnsureRolesRpc = defineRpc({
  name: "setup.ensure-roles",
  input: z.object({ resume: z.boolean().optional() }),
  output: z.object({
    created: z.array(setupRoleSchema),
    baseProvider: z.string().nullable(),
    model: z.string().nullable(),
    /** Only when this call created the Reviewer on another model family's provider (autonomy design §C.5). */
    reviewer: reviewerApartSchema.optional(),
    skipped: z.literal("cleaned-up").nullable(),
  }),
});

/**
 * `setup.grant-agent-tools` — turns Paseo's machine-wide agent-tools switch on
 * (design §7.13.3, ADR-012 decision 5).
 *
 * `confirmed` must be `true`: the screen sends it only after the user read the
 * warning that the switch applies to every agent on the machine, not only to
 * paseo-bm's three roles.
 */
export const setupGrantAgentToolsRpc = defineRpc({
  name: "setup.grant-agent-tools",
  input: z.object({ confirmed: z.literal(true) }),
  output: z.object({ injectIntoAgents: z.literal(true), changed: z.boolean() }),
});

/**
 * `setup.install-skills` — runs the third-party `skills` CLI once, after the
 * user confirmed the exact command (design §7.13.4).
 *
 * The plugin still writes no skill folder itself; the only thing that changes
 * one is the process the user chose to start.
 */
export const setupInstallSkillsRpc = defineRpc({
  name: "setup.install-skills",
  input: z.object({ confirmed: z.literal(true) }),
  output: z.object({
    command: z.string(),
    code: z.number().int(),
    tail: z.array(z.string()),
    missingBefore: missingRequiredSchema,
    missingAfter: missingRequiredSchema,
  }),
});

/**
 * `setup.cleanup` — "Remove paseo-bm's settings" (design §7.13.7).
 *
 * `deleteData` is a second, separate choice, defaulted to keeping the data on
 * the screen: the configuration can be recreated with one press, a user's
 * traces cannot. The plugin never removes itself, so the answer names the
 * command the user runs next.
 */
export const setupCleanupRpc = defineRpc({
  name: "setup.cleanup",
  input: z.object({ confirmed: z.literal(true), deleteData: z.boolean() }),
  output: z.object({
    removedProviders: z.array(z.string()),
    removedProfiles: z.array(z.string()),
    agentTools: z.enum(["restored", "left-on", "off"]),
    data: z.object({ deleted: z.array(z.string()), kept: z.array(z.string()) }).nullable(),
    nextCommand: z.literal("paseo plugin remove paseo-bm"),
  }),
});

/** `setup.install-tool` — runs the documented installer for a missing `br` or `bv`, after the user confirmed. */
export const setupInstallToolRpc = defineRpc({
  name: "setup.install-tool",
  /** `confirmed` must be `true`: Settings sends it only after the user confirmed the exact command. */
  input: z.object({ tool: z.enum(["br", "bv"]), confirmed: z.literal(true) }),
  output: z.object({ command: z.string(), code: z.number().int(), tail: z.array(z.string()) }),
});
